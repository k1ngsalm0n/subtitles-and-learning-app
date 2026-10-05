"""Tests for the RFC 8305 connect race in server/happy_eyeballs.py.

Run from the project root with:  python -m unittest discover -s test
"""

import contextlib
import os
import socket
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import happy_eyeballs as he  # noqa: E402

# TEST-NET-1 (RFC 5737): guaranteed unassigned, so a connect either hangs in
# SYN-SENT (the black-hole case the race exists for) or is rejected fast by a
# local gateway — the race must win quickly either way.
BLACKHOLE = "192.0.2.1"


def addrinfo(host, port):
    return (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (host, port))


@contextlib.contextmanager
def listener():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind(("127.0.0.1", 0))
        server.listen(5)
        yield server.getsockname()[1]
    finally:
        server.close()


def free_port():
    """A port nothing is listening on, so connects are refused."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@contextlib.contextmanager
def fake_resolution(addrinfos):
    original = socket.getaddrinfo
    socket.getaddrinfo = lambda *args, **kwargs: list(addrinfos)
    try:
        yield
    finally:
        socket.getaddrinfo = original


class InterleaveTest(unittest.TestCase):
    def test_alternates_families_preserving_first_preference(self):
        v6 = lambda n: (socket.AF_INET6, 1, 6, "", (f"2001:db8::{n}", 443, 0, 0))
        v4 = lambda n: (socket.AF_INET, 1, 6, "", (f"192.0.2.{n}", 443))
        result = he.interleave_by_family([v6(1), v6(2), v6(3), v4(1), v4(2)])
        self.assertEqual(result, [v6(1), v4(1), v6(2), v4(2), v6(3)])

    def test_single_family_unchanged(self):
        infos = [addrinfo("192.0.2.1", 80), addrinfo("192.0.2.2", 80)]
        self.assertEqual(he.interleave_by_family(infos), infos)

    def test_empty(self):
        self.assertEqual(he.interleave_by_family([]), [])


class HappyConnectTest(unittest.TestCase):
    def test_connects_to_listener(self):
        with listener() as port:
            sock = he.happy_connect(("127.0.0.1", port), timeout=5)
            self.assertEqual(sock.getpeername(), ("127.0.0.1", port))
            self.assertEqual(sock.gettimeout(), 5)
            sock.close()

    def test_falls_back_when_first_address_refuses(self):
        with listener() as port:
            infos = [addrinfo("127.0.0.1", free_port()), addrinfo("127.0.0.1", port)]
            with fake_resolution(infos):
                sock = he.happy_connect(("example.invalid", port), timeout=5)
            self.assertEqual(sock.getpeername()[1], port)
            sock.close()

    def test_races_past_a_black_hole(self):
        with listener() as port:
            infos = [addrinfo(BLACKHOLE, 443), addrinfo("127.0.0.1", port)]
            with fake_resolution(infos):
                start = time.monotonic()
                sock = he.happy_connect(("example.invalid", port), timeout=30)
                elapsed = time.monotonic() - start
            self.assertEqual(sock.getpeername()[1], port)
            sock.close()
            # The whole point: ~ATTEMPT_DELAY, not the kernel's ~2 min give-up.
            self.assertLess(elapsed, 5)

    def test_raises_last_error_when_all_refuse(self):
        infos = [addrinfo("127.0.0.1", free_port()), addrinfo("127.0.0.1", free_port())]
        with fake_resolution(infos):
            with self.assertRaises(OSError):
                he.happy_connect(("example.invalid", 1), timeout=5)

    def test_times_out_when_nothing_answers(self):
        infos = [addrinfo(BLACKHOLE, 443)]
        with fake_resolution(infos):
            start = time.monotonic()
            # A gateway may refuse instead of black-holing, so OSError is also
            # acceptable — either way it must not take the kernel's ~2 min.
            with self.assertRaises((TimeoutError, OSError)):
                he.happy_connect(("example.invalid", 443), timeout=0.5)
            self.assertLess(time.monotonic() - start, 5)


class PatchingTest(unittest.TestCase):
    def test_socket_create_connection_is_patched_and_works(self):
        self.assertIs(socket.create_connection, he._create_connection)
        with listener() as port:
            sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            self.assertEqual(sock.getpeername(), ("127.0.0.1", port))
            sock.close()

    def test_urllib3_create_connection_is_patched_and_works(self):
        try:
            from urllib3.util import connection as u3_connection
        except ImportError:
            self.skipTest("urllib3 not installed")
        self.assertNotEqual(
            u3_connection.create_connection.__module__, "urllib3.util.connection"
        )
        with listener() as port:
            sock = u3_connection.create_connection(
                ("127.0.0.1", port),
                timeout=5,
                socket_options=[(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)],
            )
            self.assertEqual(sock.getpeername(), ("127.0.0.1", port))
            # Non-zero, not 1: Linux reads the option back as 1, but macOS
            # reports 4 for the same "on", so an exact 1 failed there.
            self.assertNotEqual(
                sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY), 0
            )
            sock.close()


if __name__ == "__main__":
    unittest.main()
