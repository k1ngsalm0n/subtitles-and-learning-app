"""Prefer IPv4 for outbound connections (import for its side effect).

Python's socket layer has no happy-eyeballs: on a network that advertises
IPv6 but black-holes it, every HTTPS request (huggingface_hub update checks,
model downloads) hangs in SYN-SENT until the kernel gives up (~2 min per
attempt), stalling transcription/translation indefinitely. Browsers and Node
fall back to IPv4 instantly, which is why only the Python side breaks.

Sorting getaddrinfo results IPv4-first fixes that machine without hurting
hosts where IPv6 works — IPv6 addresses are kept as fallbacks. Same reason
import.mjs passes --force-ipv4 to yt-dlp.
"""

import socket

_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_first(*args, **kwargs):
    results = _orig_getaddrinfo(*args, **kwargs)
    return sorted(results, key=lambda r: r[0] != socket.AF_INET)


socket.getaddrinfo = _ipv4_first
