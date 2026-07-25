"""Happy Eyeballs (RFC 8305) for outbound TCP (import for its side effect).

Python's socket layer connects to resolved addresses strictly one at a time:
on a network that advertises IPv6 but black-holes it, every HTTPS request
(huggingface_hub update checks, model downloads) hangs in SYN-SENT until the
kernel gives up (~2 min per attempt) before IPv4 is even tried. Browsers and
Node race both families and fall back instantly, which is why only the Python
side breaks.

Importing this module replaces `socket.create_connection` (and urllib3's
private clone of it, which requests/huggingface_hub actually use) with a
staggered dual-stack race: attempts start in resolver order but alternate
address families, each new attempt beginning 250 ms after the previous one,
and the first to complete wins. Healthy networks keep their IPv6 preference
at full speed; the black-holed one falls back to IPv4 in ~250 ms per
connection instead of minutes.

yt-dlp runs in its own interpreter, so import.mjs injects this same module
into it through ytdlp_shim/sitecustomize.py on PYTHONPATH.
"""

import errno
import os
import selectors
import socket
import time
from itertools import zip_longest

# RFC 8305 §5 "Connection Attempt Delay" — its recommended default.
ATTEMPT_DELAY = 0.25

_orig_create_connection = socket.create_connection
_GLOBAL_DEFAULT = socket._GLOBAL_DEFAULT_TIMEOUT


def interleave_by_family(addrinfos):
    """Reorder getaddrinfo results to alternate address families (RFC 8305 §4).

    The resolver's preferred family keeps the first slot; within a family the
    original order is preserved.
    """
    buckets = {}
    for info in addrinfos:
        buckets.setdefault(info[0], []).append(info)
    interleaved = []
    for batch in zip_longest(*buckets.values()):
        interleaved.extend(info for info in batch if info is not None)
    return interleaved


def _start_attempt(info, source_address, socket_options, sel, pending, errors):
    """Kick off one non-blocking connect. Returns the socket only if it
    connected instantly (e.g. localhost); otherwise it's registered in `sel`
    or its failure is recorded in `errors`."""
    family, kind, proto, _canon, sockaddr = info
    sock = None
    try:
        sock = socket.socket(family, kind, proto)
        for opt in socket_options or ():
            sock.setsockopt(*opt)
        if source_address:
            sock.bind(source_address)
        sock.setblocking(False)
        code = sock.connect_ex(sockaddr)
    except OSError as exc:
        errors.append(exc)
        if sock is not None:
            sock.close()
        return None
    if code == 0:
        return sock
    if code in (errno.EINPROGRESS, errno.EWOULDBLOCK):
        sel.register(sock, selectors.EVENT_WRITE, sockaddr)
        pending.add(sock)
        return None
    errors.append(OSError(code, os.strerror(code), str(sockaddr)))
    sock.close()
    return None


def happy_connect(address, timeout=None, source_address=None, socket_options=None):
    """Connect to (host, port) racing address families, RFC 8305 style.

    `timeout` is the overall deadline for the whole race (None = no limit),
    and is also set on the returned socket, matching create_connection.
    """
    host, port = address
    if isinstance(host, str) and host.startswith("["):
        host = host.strip("[]")  # urllib3 passes bracketed IPv6 literals
    addrinfos = interleave_by_family(
        socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    )
    if not addrinfos:
        raise OSError(f"getaddrinfo returned no addresses for {host!r}")

    deadline = None if timeout is None else time.monotonic() + timeout
    queue = list(addrinfos)
    pending = set()
    errors = []
    winner = None
    sel = selectors.DefaultSelector()
    try:
        next_attempt = time.monotonic()
        while True:
            now = time.monotonic()
            # Launch the next attempt when its stagger delay expires — or
            # immediately if every attempt so far has already failed outright.
            while queue and (now >= next_attempt or not pending):
                winner = _start_attempt(
                    queue.pop(0), source_address, socket_options, sel, pending, errors
                )
                if winner is not None:
                    return winner
                next_attempt = time.monotonic() + ATTEMPT_DELAY
                now = time.monotonic()

            if not pending and not queue:
                raise errors[-1] if errors else OSError(
                    f"no connectable address for {host!r}"
                )

            waits = []
            if queue:
                waits.append(next_attempt - now)
            if deadline is not None:
                waits.append(deadline - now)
            wait = max(0, min(waits)) if waits else None

            for key, _events in sel.select(wait):
                sock = key.fileobj
                sel.unregister(sock)
                pending.discard(sock)
                err = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                if err == 0:
                    winner = sock
                    return winner
                errors.append(OSError(err, os.strerror(err), str(key.data)))
                sock.close()

            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(
                    f"timed out connecting to {host!r}:{port} "
                    f"(tried {len(addrinfos) - len(queue)} address(es))"
                )
    finally:
        sel.close()
        for sock in pending:
            if sock is not winner:
                sock.close()
        if winner is not None:
            winner.settimeout(timeout)


def _create_connection(
    address, timeout=_GLOBAL_DEFAULT, source_address=None, *, all_errors=False
):
    if timeout is _GLOBAL_DEFAULT:
        timeout = socket.getdefaulttimeout()
    try:
        return happy_connect(address, timeout, source_address)
    except (OSError, TimeoutError):
        raise
    except Exception:
        # A bug in the race must never take networking down with it.
        return _orig_create_connection(address, timeout, source_address)


def _patch_urllib3():
    """urllib3 (and so requests/huggingface_hub) bypasses
    socket.create_connection with its own copy — patch that too."""
    try:
        from urllib3.util import connection as u3_connection
    except Exception:
        return
    try:
        from urllib3.util.timeout import _DEFAULT_TIMEOUT as u3_default
    except Exception:
        u3_default = _GLOBAL_DEFAULT

    def create_connection(
        address, timeout=u3_default, source_address=None, socket_options=None
    ):
        if timeout is u3_default or timeout is _GLOBAL_DEFAULT:
            timeout = socket.getdefaulttimeout()
        try:
            return happy_connect(address, timeout, source_address, socket_options)
        except (OSError, TimeoutError):
            raise
        except Exception:
            return _orig_create_connection(address, timeout, source_address)

    u3_connection.create_connection = create_connection
    # Some urllib3 versions re-export the name; keep them consistent.
    try:
        import urllib3.connection as u3_conn_mod

        if hasattr(u3_conn_mod, "create_connection"):
            u3_conn_mod.create_connection = create_connection
    except Exception:
        pass


socket.create_connection = _create_connection
_patch_urllib3()
