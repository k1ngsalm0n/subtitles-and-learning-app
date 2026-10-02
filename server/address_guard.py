"""Refuse private addresses at connect time, inside yt-dlp (#19).

`rejectPrivateHost` in server/util.mjs checks a URL before the import starts,
but yt-dlp resolves the host again when it fetches. A name that answers with a
public address for the check and a private one a moment later (DNS rebinding)
was let through, and so was anything yt-dlp reached *after* the first URL: an
HTTP redirect, an embedded player, the host the media itself is served from.
None of those were ever checked.

This closes both by moving the check to the one point every Python connection
passes through. yt-dlp's own connection helper, urllib3's, and
happy_eyeballs.happy_connect all call `socket.getaddrinfo` and then connect to
exactly the addresses it returned — so filtering the private ones out *here*
means the address checked is the address used, with no second lookup in
between for an answer to change.

A host that resolves to public and private addresses keeps the public ones.
One that resolves only to private ones is refused with REFUSED_MARKER in the
message, which import.mjs looks for to give the reader a plain explanation.

Loaded into yt-dlp by ytdlp_shim/sitecustomize.py. The ranges mirror
isPrivateAddress in server/util.mjs rule for rule; test_address_guard.py runs
both over the same addresses and fails if they ever disagree.

Not covered: anything yt-dlp hands to another program. ffmpeg (live streams,
RTSP, MMS) and rtmpdump resolve names themselves. import.mjs passes
`--downloader native` so ordinary and HLS downloads stay in Python.
"""

import ipaddress
import os
import socket
from urllib.parse import urlsplit

REFUSED_MARKER = "stele: refused a private network address"

_orig_getaddrinfo = socket.getaddrinfo


def _private_ipv4(a, b, c, d):
    # Same table, same order, as isPrivateIpv4 in server/util.mjs.
    return (
        a == 0                              # 0.0.0.0/8 — "this host"
        or a == 10                          # private
        or a == 127                         # the whole loopback block
        or (a == 100 and 64 <= b <= 127)    # carrier-grade NAT
        or (a == 169 and b == 254)          # link-local, incl. cloud metadata
        or (a == 172 and 16 <= b <= 31)     # private
        or (a == 192 and b == 168)          # private
        or (a == 192 and b == 0 and c == 0) # IETF protocol assignments
        or (a == 198 and b in (18, 19))     # benchmarking
        or a >= 224                         # multicast and reserved
    )


def _v4_from(hi, lo):
    return _private_ipv4(hi >> 8, hi & 0xFF, lo >> 8, lo & 0xFF)


def _private_ipv6(g):
    # Same rules as isPrivateIpv6 in server/util.mjs: wrappers that carry an
    # IPv4 address are judged as that address; the rest are never public.
    zero = lambda start, end: all(x == 0 for x in g[start:end])  # noqa: E731
    if zero(0, 5) and g[5] == 0xFFFF:                      # ::ffff:0:0/96
        return _v4_from(g[6], g[7])
    if g[0] == 0x64 and g[1] == 0xFF9B and zero(2, 6):     # 64:ff9b::/96 NAT64
        return _v4_from(g[6], g[7])
    if g[0] == 0x2002:                                     # 2002::/16 6to4
        return _v4_from(g[1], g[2])
    return (
        zero(0, 6)                                         # ::/96
        or (g[0] == 0x64 and g[1] == 0xFF9B and g[2] == 1) # 64:ff9b:1::/48
        or (g[0] & 0xFE00) == 0xFC00                       # fc00::/7 unique local
        or (g[0] & 0xFFC0) == 0xFE80                       # fe80::/10 link-local
        or (g[0] & 0xFFC0) == 0xFEC0                       # fec0::/10 site-local
        or (g[0] & 0xFF00) == 0xFF00                       # ff00::/8 multicast
    )


def is_private(address):
    """True unless `address` is an IP literal on the public internet.

    Anything that doesn't parse is private: a check that guesses is worse than
    no check, because it reads as one.
    """
    if not isinstance(address, str):
        return True
    # A scoped IPv6 address (fe80::1%eth0) carries its interface after a "%".
    address = address.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    if ip.version == 4:
        return _private_ipv4(*ip.packed)
    packed = ip.packed
    return _private_ipv6([(packed[i] << 8) | packed[i + 1] for i in range(0, 16, 2)])


def _proxy_hosts():
    """Hosts named by the proxy variables, which are allowed to be local.

    A proxy on this machine (127.0.0.1:8080) is a common setup, and refusing it
    would break every import for whoever has one. Traffic through a proxy is
    resolved by the proxy, so this guard can't see it either way; it is the
    reader's own configuration.
    """
    hosts = set()
    for name in ("http_proxy", "https_proxy", "all_proxy"):
        for value in (os.environ.get(name), os.environ.get(name.upper())):
            if not value:
                continue
            if "://" not in value:
                value = f"http://{value}"
            try:
                host = urlsplit(value).hostname
            except ValueError:
                continue
            if host:
                hosts.add(host.lower())
    return hosts


_EXEMPT = _proxy_hosts()


def guarded_getaddrinfo(host, port, *args, **kwargs):
    infos = _orig_getaddrinfo(host, port, *args, **kwargs)
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    if isinstance(host, str) and host.strip("[]").lower() in _EXEMPT:
        return infos
    public = [info for info in infos if not is_private(info[4][0])]
    if infos and not public:
        raise OSError(f"{REFUSED_MARKER}: {host} resolves only to private addresses")
    return public


def install():
    socket.getaddrinfo = guarded_getaddrinfo


install()
