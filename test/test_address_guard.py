"""server/address_guard.py: private addresses refused at connect time (#19).

The guard is the second copy of the range table in server/util.mjs, so the
test that matters most is the one that runs both over the same addresses and
fails on any disagreement.
"""

import json
import os
import random
import shutil
import socket
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import address_guard  # noqa: E402  (installs itself; the tests call it directly)

# The guard patches socket.getaddrinfo on import. Put the real one back so the
# rest of the suite isn't run behind it.
socket.getaddrinfo = address_guard._orig_getaddrinfo


def info(address):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sockaddr = (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443)
    return (family, socket.SOCK_STREAM, 6, "", sockaddr)


class FakeResolver:
    """A resolver whose answers are scripted, one list per call."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = 0

    def __call__(self, host, port, *args, **kwargs):
        self.calls += 1
        return [info(a) for a in self.answers.pop(0)]


class GuardTest(unittest.TestCase):
    def setUp(self):
        self._orig = address_guard._orig_getaddrinfo
        self._exempt = address_guard._EXEMPT

    def tearDown(self):
        address_guard._orig_getaddrinfo = self._orig
        address_guard._EXEMPT = self._exempt

    def resolve_with(self, *answers):
        address_guard._orig_getaddrinfo = FakeResolver(*answers)
        return lambda host="example.com": address_guard.guarded_getaddrinfo(host, 443)

    def test_private_addresses(self):
        for address in [
            "127.0.0.1", "127.9.9.9", "0.0.0.0", "10.0.0.1", "172.16.0.1",
            "172.31.255.255", "192.168.1.1", "100.64.0.1", "169.254.169.254",
            "198.18.0.1", "192.0.0.1", "224.0.0.1", "255.255.255.255",
            "::", "::1", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1",
            "fe80::1", "fe80::1%eth0", "fd12:3456::1", "fc00::1", "fec0::1",
            "ff02::1", "64:ff9b::127.0.0.1", "64:ff9b:1::1", "2002:7f00:1::",
            "2002:a9fe:a9fe::1", "not an address", "",
        ]:
            with self.subTest(address=address):
                self.assertTrue(address_guard.is_private(address))

    def test_public_addresses(self):
        for address in [
            "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1",
            "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8",
            "2002:808:808::1", "2001:db8::1",
        ]:
            with self.subTest(address=address):
                self.assertFalse(address_guard.is_private(address))

    def test_a_rebinding_answer_is_refused_on_the_lookup_that_connects(self):
        # The first lookup is the one a pre-check would see; the second is the
        # one the connection uses. Only the second decides anything now.
        resolve = self.resolve_with(["93.184.216.34"], ["127.0.0.1"])
        self.assertEqual(resolve()[0][4][0], "93.184.216.34")
        with self.assertRaises(OSError) as caught:
            resolve()
        self.assertIn(address_guard.REFUSED_MARKER, str(caught.exception))

    def test_a_mixed_answer_keeps_only_the_public_addresses(self):
        resolve = self.resolve_with(["127.0.0.1", "93.184.216.34", "::1", "2606:4700::1"])
        self.assertEqual(
            [i[4][0] for i in resolve()], ["93.184.216.34", "2606:4700::1"]
        )

    def test_an_ip_literal_is_judged_like_any_other_answer(self):
        resolve = self.resolve_with(["169.254.169.254"])
        with self.assertRaises(OSError):
            resolve("169.254.169.254")

    def test_an_empty_answer_is_passed_through_for_the_caller_to_handle(self):
        self.assertEqual(self.resolve_with([])(), [])

    def test_a_configured_proxy_may_be_local(self):
        address_guard._EXEMPT = {"127.0.0.1", "proxy.lan"}
        resolve = self.resolve_with(["127.0.0.1"], ["192.168.1.5"])
        self.assertEqual(resolve("127.0.0.1")[0][4][0], "127.0.0.1")
        self.assertEqual(resolve("proxy.lan")[0][4][0], "192.168.1.5")

    def test_proxy_hosts_are_read_from_the_usual_variables(self):
        saved = {k: os.environ.get(k) for k in ("HTTPS_PROXY", "http_proxy", "ALL_PROXY")}
        try:
            os.environ["HTTPS_PROXY"] = "http://127.0.0.1:8080"
            os.environ["http_proxy"] = "proxy.lan:3128"
            os.environ["ALL_PROXY"] = "socks5://[::1]:1080"
            self.assertEqual(address_guard._proxy_hosts(), {"127.0.0.1", "proxy.lan", "::1"})
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class ShimTest(unittest.TestCase):
    """The shim really does put the guard in front of a fresh interpreter."""

    def run_with_shim(self, code, shim_dir=None):
        env = {**os.environ, "PYTHONPATH": shim_dir or os.path.join(ROOT, "server", "ytdlp_shim")}
        for key in [k for k in env if k.lower().endswith("_proxy")]:
            del env[key]
        return subprocess.run(
            [sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=60
        )

    def test_a_lookup_of_localhost_is_refused(self):
        result = self.run_with_shim("import socket; socket.getaddrinfo('localhost', 80)")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(address_guard.REFUSED_MARKER, result.stderr)

    def test_a_shim_that_cannot_load_the_guard_stops_the_interpreter(self):
        # Copy the shim somewhere address_guard.py isn't beside it.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            shim = os.path.join(tmp, "ytdlp_shim")
            os.makedirs(shim)
            shutil.copy(os.path.join(ROOT, "server", "ytdlp_shim", "sitecustomize.py"), shim)
            result = self.run_with_shim("print('ran without the guard')", shim)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("ran without the guard", result.stdout)
        self.assertIn("could not load its private-address guard", result.stderr)


@unittest.skipUnless(shutil.which("node"), "node is needed to compare with util.mjs")
class AgreesWithUtilMjs(unittest.TestCase):
    """The two tables are one rule set written twice; they must not drift."""

    def sample(self):
        rng = random.Random(19)
        v4 = lambda: ".".join(str(rng.randrange(256)) for _ in range(4))  # noqa: E731
        h16 = lambda: format(rng.randrange(0x10000), "x")  # noqa: E731
        out = [f"{a}.{b}.{c}.1" for a in range(256) for b in (0, 1, 16, 31, 32, 64, 127, 128, 168, 254, 255) for c in (0, 2)]
        out += [v4() for _ in range(20000)]
        out += [":".join(h16() for _ in range(8)) for _ in range(20000)]
        for _ in range(3000):
            a = v4()
            out += [f"::ffff:{a}", f"::{a}", f"64:ff9b::{a}", f"64:ff9b:1::{a}",
                    f"2002:{h16()}:{h16()}::1", f"fec0::{h16()}", f"ff{rng.randrange(256):02x}::1"]
        return out

    def test_every_address_gets_the_same_answer_from_both(self):
        addresses = self.sample()
        script = (
            "import { isPrivateAddress } from './server/util.mjs';"
            "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>"
            "process.stdout.write(JSON.stringify(JSON.parse(s).map(isPrivateAddress))));"
        )
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            input=json.dumps(addresses), capture_output=True, text=True, cwd=ROOT, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        js = json.loads(result.stdout)
        disagreements = [
            (a, j) for a, j in zip(addresses, js) if address_guard.is_private(a) != j
        ]
        self.assertEqual(disagreements[:10], [], f"{len(disagreements)} of {len(addresses)} differ")

    def test_the_refusal_marker_is_the_one_import_mjs_looks_for(self):
        with open(os.path.join(ROOT, "server", "import.mjs"), encoding="utf-8") as f:
            self.assertIn(f'"{address_guard.REFUSED_MARKER}"', f.read())


if __name__ == "__main__":
    unittest.main()
