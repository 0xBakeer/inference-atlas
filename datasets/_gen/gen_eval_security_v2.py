# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-security-v2/`.

~122 defensive cyber-security items across six families:

  * crypto — toy computations the generator solves itself: Caesar/ROT13
    decryption, XOR bytes, textbook RSA over small primes (phi, private
    exponent, encryption), Diffie-Hellman shared secrets, plus a few
    primitive-parameter facts (AES block size, SHA-256 output length).
  * network — CIDR arithmetic computed with the stdlib `ipaddress` module
    (usable hosts, network/broadcast addresses, membership), and stable
    port/protocol facts with in-table distractors.
  * web_security — scenario → vulnerability-class identification (SQLi, XSS,
    CSRF, IDOR, SSRF, …) and defence → threat matching (CSP, HttpOnly,
    SameSite, parameterized queries), distractors drawn from the same class
    tables so every wrong option is plausible.
  * forensics — questions computed from a synthetic sshd auth-log excerpt
    generated in the prompt (failure counts, the brute-forcing IP, the time of
    its eventual success), epoch→UTC conversions, an email Received-chain
    ordering question built from the chain itself, and file-signature facts.
  * concepts — stable distinctions: CIA triad mapping, authn vs authz, which
    RSA key signs/verifies/encrypts, pairwise symmetric key counts (computed),
    salting, TLS scope, CVE vs CVSS.
  * incident_judgment — hand-authored trap scenarios in the eval-commonsense-v2
    style: the tempting answer (wipe the compromised box, plug in the found
    USB stick, approve the MFA push to stop the noise) is wrong, and every row
    carries `meta.trap` naming the wrong answer it is built to catch.

Everything is identification, classification and computation — the suite never
asks a model to produce attack code. All log excerpts use RFC 5737
documentation IPs and invented hostnames.

Run: `uv run datasets/_gen/gen_eval_security_v2.py`
"""

from __future__ import annotations

import ipaddress
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260915
DATASET_ID = "eval-security-v2"
LETTERS = "ABCDE"
MC_TAIL = "Reply with the letter of the correct option only."
BARE_NUM = "Reply with the number only."

_MC_COUNTER = 0


def mc(rng: random.Random, stem: str, correct: str, distractors: list[str]) -> tuple[str, list[str], str]:
    """Shuffle distractors, then place the correct option round-robin over the labels."""
    global _MC_COUNTER
    options = list(distractors)
    rng.shuffle(options)
    idx = _MC_COUNTER % (len(options) + 1)
    _MC_COUNTER += 1
    options.insert(idx, correct)
    rendered = "\n".join(f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options))
    return f"{stem}\n\n{rendered}\n\n{MC_TAIL}", options, LETTERS[idx]


def row(category: str, difficulty: str, prompt: str, answer, scorer: str,
        choices: list[str] | None = None, meta: dict | None = None) -> dict:
    item = {"category": category, "difficulty": difficulty, "prompt": prompt,
            "answer": answer, "scorer": scorer}
    if choices:
        item["choices"] = choices
    if meta:
        item["meta"] = meta
    return item


# --------------------------------------------------------------------------------------
# crypto — computed
# --------------------------------------------------------------------------------------

CAESAR_WORDS = ["firewall", "malware", "phishing", "backdoor", "keylogger", "botnet",
                "sandbox", "honeypot", "payload", "cipher"]

SMALL_PRIMES = [11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61]


def caesar(word: str, shift: int) -> str:
    return "".join(chr((ord(c) - 97 + shift) % 26 + 97) for c in word)


def gen_crypto(rng: random.Random) -> list[dict]:
    items: list[dict] = []

    # Caesar decryption: the generator encrypts, the model must reverse it.
    for word in rng.sample(CAESAR_WORDS, 6):
        shift = rng.choice([3, 5, 7, 9, 11, 15, 19, 21])
        ct = caesar(word, shift)
        assert caesar(ct, 26 - shift) == word
        items.append(row("crypto", "hard",
                         f"The ciphertext \"{ct}\" was produced with a Caesar cipher that "
                         f"shifts each letter forward by {shift} positions in the alphabet. "
                         "Decrypt it. Reply with the decrypted word only, in lowercase.",
                         word, "exact"))
    for word in rng.sample(CAESAR_WORDS, 2):
        ct = caesar(word, 13)
        items.append(row("crypto", "medium",
                         f"Decode the ROT13 string \"{ct}\". Reply with the decoded word "
                         "only, in lowercase.",
                         word, "exact"))

    # XOR bytes.
    for _ in range(3):
        a, b = rng.randrange(16, 256), rng.randrange(16, 256)
        items.append(row("crypto", "medium",
                         f"Compute 0x{a:02X} XOR 0x{b:02X}. Give the result as a decimal "
                         f"number. {BARE_NUM}",
                         str(a ^ b), "numeric"))
    # One-time pad: recover the key byte.
    p, k = rng.randrange(16, 256), rng.randrange(16, 256)
    c = p ^ k
    items.append(row("crypto", "medium",
                     f"A single plaintext byte 0x{p:02X} was XOR-encrypted with a one-byte "
                     f"key, giving ciphertext 0x{c:02X}. What is the key, as a decimal "
                     f"number? {BARE_NUM}",
                     str(k), "numeric"))

    # Textbook RSA over small primes.
    for _ in range(4):
        while True:
            pq = rng.sample(SMALL_PRIMES, 2)
            pp, qq = pq
            phi = (pp - 1) * (qq - 1)
            e = rng.choice([3, 5, 7, 17])
            try:
                d = pow(e, -1, phi)
            except ValueError:
                continue
            break
        n = pp * qq
        m = rng.randrange(2, min(n - 1, 50))
        ct = pow(m, e, n)
        assert pow(ct, d, n) == m
        kind = rng.choice(["phi", "d", "enc"])
        if kind == "phi":
            items.append(row("crypto", "medium",
                             f"In textbook RSA with primes p = {pp} and q = {qq}, what is "
                             f"the value of Euler's totient phi(n) = (p-1)(q-1)? {BARE_NUM}",
                             str(phi), "numeric"))
        elif kind == "d":
            items.append(row("crypto", "hard",
                             f"In textbook RSA with primes p = {pp} and q = {qq} and public "
                             f"exponent e = {e}, the private exponent d is the inverse of e "
                             f"modulo (p-1)(q-1). Compute d. Work through it step by step, "
                             "then give the final answer on the last line in the form "
                             "'Answer: <number>'.",
                             str(d), "numeric"))
        else:
            items.append(row("crypto", "hard",
                             f"In textbook RSA with n = {n} and public exponent e = {e}, "
                             f"encrypt the message m = {m} by computing m^e mod n. Work "
                             "through it step by step, then give the final answer on the "
                             "last line in the form 'Answer: <number>'.",
                             str(ct), "numeric"))

    # Diffie-Hellman toy exchanges.
    for _ in range(2):
        prime = rng.choice([23, 29, 31, 37, 41, 43])
        g = rng.choice([2, 3, 5])
        a, b = rng.randrange(2, 12), rng.randrange(2, 12)
        pub_a, pub_b = pow(g, a, prime), pow(g, b, prime)
        shared = pow(pub_b, a, prime)
        assert shared == pow(pub_a, b, prime)
        items.append(row("crypto", "hard",
                         f"In a Diffie-Hellman exchange with prime p = {prime} and "
                         f"generator g = {g}, Alice's secret is a = {a} and Bob's public "
                         f"value is B = {pub_b}. The shared secret is B^a mod p. Compute "
                         "it. Work through it step by step, then give the final answer on "
                         "the last line in the form 'Answer: <number>'.",
                         str(shared), "numeric"))

    # A few stable primitive facts (the AES one is a classic confusion).
    prompt, choices, letter = mc(rng,
        "AES-256 encrypts data in blocks. How large is one AES block?",
        "128 bits", ["256 bits", "64 bits", "512 bits"])
    items.append(row("crypto", "medium", prompt, letter, "mc", choices,
                     {"trap": "The 256 in AES-256 is the key size; the block size is always 128 bits."}))
    prompt, choices, letter = mc(rng,
        "How long is the output (digest) of SHA-256?",
        "256 bits", ["256 bytes", "128 bits", "512 bits"])
    items.append(row("crypto", "easy", prompt, letter, "mc", choices))
    prompt, choices, letter = mc(rng,
        "Which of these best describes a cryptographic hash function?",
        "A one-way function producing a fixed-size digest; it cannot be decrypted",
        ["A reversible cipher whose key is the digest",
         "A compression algorithm optimised for text",
         "An encoding like Base64 that can be undone without a key"])
    items.append(row("crypto", "easy", prompt, letter, "mc", choices,
                     {"trap": "Hashing is routinely confused with encryption/encoding; it is neither."}))

    return items


# --------------------------------------------------------------------------------------
# network — CIDR computed + port/protocol facts
# --------------------------------------------------------------------------------------

PORTS = {
    "21": "FTP (control)", "22": "SSH", "23": "Telnet", "25": "SMTP",
    "53": "DNS", "80": "HTTP", "110": "POP3", "143": "IMAP",
    "161": "SNMP", "389": "LDAP", "443": "HTTPS", "445": "SMB",
    "587": "SMTP message submission", "636": "LDAPS", "3306": "MySQL",
    "3389": "RDP (Remote Desktop)", "5432": "PostgreSQL", "6379": "Redis",
}


def gen_network(rng: random.Random) -> list[dict]:
    items: list[dict] = []

    # Usable host counts.
    for prefix in rng.sample([20, 21, 22, 23, 25, 26, 27, 28], 4):
        usable = 2 ** (32 - prefix) - 2
        items.append(row("network", "medium",
                         f"How many usable host addresses does an IPv4 /{prefix} subnet "
                         f"provide, after excluding the network and broadcast addresses? "
                         f"{BARE_NUM}",
                         str(usable), "numeric"))

    # Network / broadcast address of a random subnet.
    for _ in range(4):
        prefix = rng.choice([21, 22, 23, 25, 26, 27])
        base = ipaddress.IPv4Address(f"10.{rng.randrange(0, 200)}.{rng.randrange(0, 200)}.0")
        host = ipaddress.IPv4Address(int(base) + rng.randrange(1, 2 ** (32 - prefix) - 1))
        net = ipaddress.IPv4Network(f"{host}/{prefix}", strict=False)
        which = rng.choice(["network", "broadcast"])
        answer = str(net.network_address if which == "network" else net.broadcast_address)
        items.append(row("network", "hard",
                         f"The host {host}/{prefix} sits in an IPv4 subnet. What is the "
                         f"{which} address of that subnet? Reply with the IPv4 address "
                         "only, in dotted decimal.",
                         answer, "exact"))

    # Which of these addresses is inside the subnet?
    for _ in range(3):
        prefix = rng.choice([22, 24, 26])
        net = ipaddress.IPv4Network(
            f"172.{rng.randrange(16, 32)}.{rng.randrange(0, 200)}.0/{prefix}", strict=False)
        inside = ipaddress.IPv4Address(int(net.network_address) + rng.randrange(1, net.num_addresses - 1))
        outs = []
        while len(outs) < 3:
            cand = ipaddress.IPv4Address(
                f"172.{rng.randrange(16, 32)}.{rng.randrange(0, 200)}.{rng.randrange(1, 255)}")
            if cand not in net and str(cand) not in outs:
                outs.append(str(cand))
        assert inside in net
        prompt, choices, letter = mc(rng,
            f"Which of these IPv4 addresses belongs to the subnet {net}?",
            str(inside), outs)
        items.append(row("network", "hard", prompt, letter, "mc", choices))

    # Port ↔ service, distractors from the same table.
    for port in rng.sample(list(PORTS), 6):
        service = PORTS[port]
        distract = rng.sample([v for k, v in PORTS.items() if k != port], 3)
        prompt, choices, letter = mc(rng,
            f"Which service conventionally listens on TCP port {port}?", service, distract)
        items.append(row("network", "medium", prompt, letter, "mc", choices))
    for port in rng.sample(list(PORTS), 2):
        service = PORTS[port]
        distract = rng.sample([k for k in PORTS if k != port], 3)
        prompt, choices, letter = mc(rng,
            f"On which TCP port does {service} conventionally listen?", port, distract)
        items.append(row("network", "medium", prompt, letter, "mc", choices))

    # Protocol behaviour facts.
    prompt, choices, letter = mc(rng,
        "In what order are packets exchanged in a TCP three-way handshake?",
        "SYN, then SYN-ACK, then ACK",
        ["ACK, then SYN, then SYN-ACK", "SYN, then ACK, then SYN-ACK",
         "HELLO, then KEY-EXCHANGE, then FINISHED"])
    items.append(row("network", "easy", prompt, letter, "mc", choices))
    prompt, choices, letter = mc(rng,
        "Which of these application protocols traditionally runs over UDP rather than TCP?",
        "NTP (network time)", ["SMTP (email delivery)", "SSH", "IMAP"])
    items.append(row("network", "medium", prompt, letter, "mc", choices))
    prompt, choices, letter = mc(rng,
        "What does ARP resolve on a local network?",
        "An IPv4 address to a MAC (hardware) address",
        ["A hostname to an IPv4 address", "A MAC address to a port number",
         "A URL to a certificate"])
    items.append(row("network", "medium", prompt, letter, "mc", choices))

    return items


# --------------------------------------------------------------------------------------
# web_security — scenario → class, defence → threat
# --------------------------------------------------------------------------------------

VULN_SCENARIOS = [
    ("A product page renders the `q` search parameter into the HTML response without "
     "escaping, so a crafted link executes script in the victim's browser when opened.",
     "Reflected cross-site scripting (XSS)",
     ["SQL injection", "Cross-site request forgery (CSRF)", "Server-side request forgery (SSRF)"],
     "medium"),
    ("A comment field stores user input verbatim; script tags in a saved comment later "
     "run in every visitor's browser when the comment is displayed.",
     "Stored cross-site scripting (XSS)",
     ["Reflected cross-site scripting (XSS)", "Insecure deserialization", "Clickjacking"],
     "medium"),
    ("Changing the numeric id in `/invoices/1042` to `/invoices/1043` shows another "
     "customer's invoice, with no ownership check on the server.",
     "Insecure direct object reference (IDOR) / broken access control",
     ["SQL injection", "Path traversal", "Session fixation"],
     "medium"),
    ("While the victim is logged in to their bank, a hidden form on a malicious page "
     "auto-submits a transfer request to the bank, and the browser attaches the session "
     "cookie automatically.",
     "Cross-site request forgery (CSRF)",
     ["Stored cross-site scripting (XSS)", "Open redirect", "Server-side request forgery (SSRF)"],
     "medium"),
    ("A login form built by string-concatenating the username into a database query "
     "returns all rows when the input `' OR '1'='1` is submitted.",
     "SQL injection",
     ["Command injection", "LDAP injection", "Insecure direct object reference (IDOR)"],
     "easy"),
    ("An 'import from URL' feature makes the server fetch any URL the user supplies; an "
     "attacker uses it to read the cloud instance-metadata service at 169.254.169.254.",
     "Server-side request forgery (SSRF)",
     ["Cross-site request forgery (CSRF)", "Open redirect", "XML external entity (XXE) injection"],
     "hard"),
    ("A file-download endpoint accepts `?file=../../etc/passwd` and returns the server's "
     "password file.",
     "Path traversal",
     ["Insecure direct object reference (IDOR)", "SQL injection", "Local file inclusion via SSRF"],
     "medium"),
    ("A diagnostics page passes the user-supplied hostname straight into a shell call to "
     "`ping`; submitting `example.com; cat /etc/shadow` runs the extra command.",
     "OS command injection",
     ["SQL injection", "Server-side request forgery (SSRF)", "Insecure deserialization"],
     "medium"),
    ("An XML upload parser resolves external entity declarations, letting a crafted "
     "document read local files into the parsed output.",
     "XML external entity (XXE) injection",
     ["Path traversal", "Insecure deserialization", "Server-side template injection"],
     "hard"),
    ("The `?next=` parameter after login forwards the browser to any URL, and phishers "
     "use the trusted domain to bounce victims to a fake login page.",
     "Open redirect",
     ["Cross-site request forgery (CSRF)", "Reflected cross-site scripting (XSS)", "Clickjacking"],
     "medium"),
    ("An attacker frames the target site invisibly under their own page and tricks the "
     "victim into clicking a button that is actually the target site's 'delete account'.",
     "Clickjacking",
     ["Cross-site request forgery (CSRF)", "Open redirect", "Session fixation"],
     "medium"),
    ("The application accepts a serialized object from the client and instantiates it "
     "blindly; a crafted payload executes code during deserialization.",
     "Insecure deserialization",
     ["XML external entity (XXE) injection", "OS command injection", "Prototype pollution"],
     "hard"),
]

DEFENCE_MATCH = [
    ("Which defence most directly prevents SQL injection?",
     "Parameterized queries / prepared statements",
     ["Output encoding of HTML entities", "A Content-Security-Policy header", "TLS everywhere"],
     "easy",
     None),
    ("Which cookie attribute prevents JavaScript on the page from reading a cookie?",
     "HttpOnly",
     ["Secure", "SameSite=Strict", "Path=/"],
     "medium",
     None),
    ("Which cookie attribute is aimed specifically at reducing CSRF by controlling "
     "whether the cookie is sent on cross-site requests?",
     "SameSite",
     ["HttpOnly", "Secure", "Max-Age"],
     "medium",
     "HttpOnly is the tempting answer but addresses XSS cookie theft, not CSRF."),
    ("Which HTTP response header lets a site restrict where scripts may be loaded from, "
     "mitigating XSS?",
     "Content-Security-Policy",
     ["X-Frame-Options", "Strict-Transport-Security", "X-Content-Type-Options"],
     "medium",
     None),
    ("Which header (or its modern frame-ancestors equivalent) defends against "
     "clickjacking?",
     "X-Frame-Options",
     ["Content-Security-Policy's script-src directive", "Referrer-Policy", "Cache-Control"],
     "medium",
     None),
    ("What does the Secure attribute on a cookie enforce?",
     "The cookie is only sent over HTTPS connections",
     ["The cookie is encrypted at rest in the browser",
      "The cookie cannot be read by JavaScript",
      "The cookie is signed against tampering"],
     "medium",
     "'Secure' sounds like encryption or signing; it only gates transport."),
    ("Which defence most directly prevents stored XSS from executing when user content "
     "is displayed?",
     "Context-aware output encoding/escaping when rendering",
     ["Prepared statements", "Rate limiting", "Hashing the input before storage"],
     "medium",
     None),
    ("Why is hashing passwords with a per-user salt better than hashing without one?",
     "Salts defeat precomputed rainbow-table attacks and hide identical passwords",
     ["Salts make the hash reversible for password recovery",
      "Salts encrypt the password database",
      "Salts make brute force impossible rather than slower"],
     "medium",
     "The 'impossible' option overstates: salting slows and de-duplicates, it does not prevent brute force."),
]


def gen_web_security(rng: random.Random) -> list[dict]:
    items: list[dict] = []
    for scenario, correct, distract, diff in VULN_SCENARIOS:
        prompt, choices, letter = mc(rng,
            f"A security review finds the following issue:\n\n{scenario}\n\n"
            "Which vulnerability class is this?", correct, distract)
        items.append(row("web_security", diff, prompt, letter, "mc", choices))
    for stem, correct, distract, diff, trap in DEFENCE_MATCH:
        prompt, choices, letter = mc(rng, stem, correct, distract)
        meta = {"trap": trap} if trap else None
        items.append(row("web_security", diff, prompt, letter, "mc", choices, meta))
    return items


# --------------------------------------------------------------------------------------
# forensics — computed log analysis, epochs, magic bytes, email chains
# --------------------------------------------------------------------------------------

MAGIC_BYTES = {
    "4D 5A": "A Windows executable (PE/EXE)",
    "25 50 44 46": "A PDF document",
    "FF D8 FF": "A JPEG image",
    "89 50 4E 47": "A PNG image",
    "50 4B 03 04": "A ZIP archive (also DOCX/XLSX/JAR)",
    "7F 45 4C 46": "A Linux ELF executable",
    "1F 8B": "A gzip-compressed file",
    "47 49 46 38": "A GIF image",
}

DOC_IPS = ["203.0.113.45", "203.0.113.77", "198.51.100.23", "198.51.100.9",
           "192.0.2.150", "192.0.2.61"]
USERS = ["root", "admin", "deploy", "backup", "postgres", "www-data"]


def make_auth_log(rng: random.Random) -> tuple[str, str, int, str]:
    """Build an sshd log excerpt; return (log, attacker_ip, fail_count, success_time)."""
    ips = rng.sample(DOC_IPS, 3)
    attacker, benign1, benign2 = ips
    day = rng.randrange(10, 28)
    hour = rng.randrange(1, 5)
    minute = rng.randrange(2, 40)
    n_fail = rng.randrange(5, 9)
    events: list[tuple[str, str]] = []  # (time, line)

    def t(minu: int, sec: int) -> str:
        return f"Sep {day} {hour:02d}:{minu:02d}:{sec:02d}"

    user = rng.choice(USERS)
    total = minute * 60 + rng.randrange(0, 30)
    for i in range(n_fail):
        events.append((t(total // 60, total % 60),
                       f"sshd[{1000+i}]: Failed password for {user} from {attacker} "
                       f"port {50000+i} ssh2"))
        total += rng.randrange(20, 70)
    total += rng.randrange(20, 70)
    success_time = t(total // 60, total % 60)
    events.append((success_time,
                   f"sshd[{1000+n_fail}]: Accepted password for {user} from {attacker} "
                   f"port {50100} ssh2"))
    # benign noise: one failure and one success from other IPs, earlier in the hour
    events.insert(0, (t(max(0, minute - 2), 11),
                      f"sshd[900]: Accepted publickey for deploy from {benign1} port 40022 ssh2"))
    events.insert(1, (t(max(0, minute - 1), 42),
                      f"sshd[901]: Failed password for {rng.choice(USERS)} from {benign2} "
                      f"port 40188 ssh2"))
    log = "\n".join(f"{ts} web1 {line}" for ts, line in events)
    return log, attacker, n_fail, success_time.split(" ", 2)[2]


def gen_forensics(rng: random.Random) -> list[dict]:
    items: list[dict] = []

    for kind in ("count", "attacker", "success", "count", "attacker", "success"):
        log, attacker, n_fail, success_hms = make_auth_log(rng)
        preamble = ("The following is an excerpt from an SSH server's authentication "
                    f"log:\n\n```\n{log}\n```\n\n")
        if kind == "count":
            items.append(row("forensics", "medium",
                             preamble + f"How many FAILED login attempts came from "
                             f"{attacker}? {BARE_NUM}",
                             str(n_fail), "numeric"))
        elif kind == "attacker":
            distract = [ip for ip in DOC_IPS if ip != attacker]
            prompt, choices, letter = mc(rng,
                preamble + "Which IP address shows the pattern of a password brute-force "
                "attack that eventually SUCCEEDED?",
                attacker, rng.sample(distract, 3))
            items.append(row("forensics", "medium", prompt, letter, "mc", choices))
        else:
            items.append(row("forensics", "hard",
                             preamble + f"At what time did the brute-forcing IP finally "
                             "log in successfully? Reply with the time only, in HH:MM:SS "
                             "format.",
                             success_hms, "exact"))

    # Epoch → UTC.
    for _ in range(3):
        epoch = rng.randrange(1_600_000_000, 1_750_000_000)
        dt = datetime.fromtimestamp(epoch, tz=timezone.utc)
        items.append(row("forensics", "hard",
                         f"A log record carries the Unix timestamp {epoch} (seconds). "
                         "What is the corresponding UTC date and time? Reply in the exact "
                         "format YYYY-MM-DD HH:MM:SS.",
                         dt.strftime("%Y-%m-%d %H:%M:%S"), "exact"))

    # Magic bytes.
    for sig in rng.sample(list(MAGIC_BYTES), 4):
        ftype = MAGIC_BYTES[sig]
        distract = rng.sample([v for k, v in MAGIC_BYTES.items() if k != sig], 3)
        prompt, choices, letter = mc(rng,
            f"A recovered file begins with the bytes {sig} (hex). What kind of file is "
            "this most likely to be?", ftype, distract)
        items.append(row("forensics", "medium", prompt, letter, "mc", choices))

    # Email Received-chain ordering (headers list newest hop first).
    for _ in range(2):
        hops = rng.sample(["mx.corp-a.example", "relay.isp-b.example",
                           "smtp.sender-c.example", "gw.filter-d.example"], 3)
        # hops[0] received it first (origin side); headers are printed newest-first,
        # each stamped ~a minute later than the hop below it.
        day = rng.randrange(10, 28)
        base = rng.randrange(8 * 3600, 16 * 3600)
        stamps = []
        for _h in hops:
            stamps.append(base)
            base += rng.randrange(40, 140)
        header_lines = []
        for i in reversed(range(len(hops))):
            src = hops[i - 1] if i else "client [198.51.100.77]"
            s = stamps[i]
            header_lines.append(
                f"Received: from {src} by {hops[i]}; "
                f"Mon, {day} Sep 2026 {s//3600:02d}:{s%3600//60:02d}:{s%60:02d} +0000")
        headers = "\n".join(header_lines)
        distract = [h for h in hops if h != hops[0]] + ["client [198.51.100.77]"]
        prompt, choices, letter = mc(rng,
            "An email carries these Received headers (shown exactly as stacked in the "
            f"message, topmost first):\n\n```\n{headers}\n```\n\n"
            "Remembering that each server prepends its Received line on top, which "
            "server was the FIRST mail server to receive this message?",
            hops[0], rng.sample(distract, 3))
        items.append(row("forensics", "hard", prompt, letter, "mc", choices,
                         {"trap": "The topmost Received header is the LAST hop, not the first."}))

    # Email authentication facts.
    prompt, choices, letter = mc(rng,
        "What does SPF (Sender Policy Framework) let a receiving mail server check?",
        "Whether the sending server's IP is authorised to send mail for the sender's domain",
        ["Whether the message body was modified in transit",
         "Whether the recipient address exists",
         "Whether the message is encrypted end-to-end"],
        )
    items.append(row("forensics", "medium", prompt, letter, "mc", choices))
    prompt, choices, letter = mc(rng,
        "What does a valid DKIM signature on an email prove?",
        "The signed headers and body were not altered since being signed by the "
        "signing domain",
        ["The sender's IP address is on the domain's allowlist",
         "The sender's mailbox password was correct",
         "The message cannot be read by third parties"])
    items.append(row("forensics", "medium", prompt, letter, "mc", choices))

    return items


# --------------------------------------------------------------------------------------
# concepts — stable distinctions (one computed family)
# --------------------------------------------------------------------------------------

CONCEPT_MC = [
    ("A DDoS attack takes a web shop offline for a day. Which leg of the CIA triad is "
     "primarily violated?",
     "Availability", ["Confidentiality", "Integrity", "Authenticity"], "easy", None),
    ("An attacker silently alters the amounts in stored invoices. Which leg of the CIA "
     "triad is primarily violated?",
     "Integrity", ["Confidentiality", "Availability", "Non-repudiation"], "easy", None),
    ("A backup tape with unencrypted customer records is lost in transit. Which leg of "
     "the CIA triad is primarily at risk?",
     "Confidentiality", ["Integrity", "Availability", "Accountability"], "easy", None),
    ("Logging in with a password proves WHO you are; a role check that you may open the "
     "admin panel decides WHAT you may do. These two steps are, in order:",
     "Authentication, then authorization",
     ["Authorization, then authentication", "Identification, then federation",
      "Accounting, then authentication"], "easy", None),
    ("To send Bob a confidential message with RSA, Alice encrypts with which key?",
     "Bob's public key",
     ["Bob's private key", "Alice's private key", "Alice's public key"], "medium",
     None),
    ("To digitally sign a document, the signer uses which key?",
     "Their own private key",
     ["Their own public key", "The verifier's public key", "A shared session key"],
     "medium",
     "Signing and encrypting are habitually swapped; signatures use the signer's private key."),
    ("What does a CVE identifier (like CVE-2021-44228) name?",
     "One specific publicly disclosed vulnerability",
     ["A severity score from 0 to 10", "A class of attack technique",
      "A vendor's patch bundle"], "medium", None),
    ("What does a CVSS score express?",
     "The severity of a vulnerability on a 0-10 scale",
     ["The number of systems affected worldwide", "The exploit's price on the black market",
      "The age of the vulnerability in days"], "medium", None),
    ("TLS protects data in which state?",
     "In transit between two endpoints",
     ["At rest on the server's disk", "In use inside the application's memory",
      "In transit AND at rest"], "medium",
     "'HTTPS means the database is encrypted' is the classic misreading."),
    ("What is the principle of least privilege?",
     "Every account and process gets only the access its task requires",
     ["Administrators should hold as few accounts as possible",
      "Users should have the fewest passwords possible",
      "The security team should be as small as practical"], "easy", None),
    ("What characterises a zero-day vulnerability?",
     "It is exploited or disclosed before the vendor has a patch available",
     ["It takes zero days to exploit", "It affects zero-configuration services",
      "It was patched on the day of disclosure"], "medium", None),
    ("Which statement about symmetric vs asymmetric encryption is correct?",
     "Symmetric uses one shared key; asymmetric uses a public/private key pair",
     ["Symmetric is always weaker than asymmetric",
      "Asymmetric uses one shared key; symmetric uses a key pair",
      "Symmetric cannot be used for large files"], "easy", None),
    ("In a TLS connection to https://example.com, what does the server's certificate "
     "chain prove when it validates?",
     "A trusted CA vouches that the server's public key belongs to example.com",
     ["The server is free of malware",
      "The connection cannot be intercepted by the CA",
      "example.com's content is safe to download"], "medium", None),
    ("What is the 3-2-1 backup rule?",
     "Three copies of the data, on two different media, one of them off-site",
     ["Three backups per day, two verifications, one restore test",
      "Three sites, two administrators, one encryption key",
      "Back up after three changes, keep two versions, delete after one year"],
     "medium", None),
]


def gen_concepts(rng: random.Random) -> list[dict]:
    items: list[dict] = []
    for stem, correct, distract, diff, trap in CONCEPT_MC:
        prompt, choices, letter = mc(rng, stem, correct, distract)
        meta = {"trap": trap} if trap else None
        items.append(row("concepts", diff, prompt, letter, "mc", choices, meta))
    # Pairwise symmetric keys — computed.
    for n in rng.sample([8, 12, 15, 20, 25, 30], 3):
        keys = n * (n - 1) // 2
        items.append(row("concepts", "hard",
                         f"{n} people want to communicate pairwise using symmetric "
                         "encryption, with a distinct shared key for every pair. How many "
                         f"keys are needed in total? {BARE_NUM}",
                         str(keys), "numeric"))
    # Password space — computed.
    for length, alphabet, desc in [(6, 26, "6 characters, lowercase letters only"),
                                   (4, 10, "a 4-digit PIN")]:
        items.append(row("concepts", "medium",
                         f"How many distinct passwords exist for {desc}? {BARE_NUM}",
                         str(alphabet ** length), "numeric"))
    return items


# --------------------------------------------------------------------------------------
# incident_judgment — hand-authored traps
# --------------------------------------------------------------------------------------

INCIDENT_TRAPS = [
    ("A production server is confirmed compromised and the attacker may still be "
     "active. What should the response team do FIRST?",
     "Isolate the machine from the network while preserving its state for analysis",
     ["Wipe and reinstall it immediately so the attacker loses access",
      "Reboot it to clear any malware from memory",
      "Delete the attacker's files to stop the damage"],
     "medium",
     "Wiping/rebooting destroys volatile evidence; containment comes before eradication."),
    ("An accountant receives an urgent email, apparently from the CEO, demanding gift "
     "cards be bought and the codes sent back within the hour. The address looks almost "
     "right. What is the correct action?",
     "Verify the request through a separate known channel (call the CEO's known number) "
     "before doing anything",
     ["Comply quickly — delaying a CEO request is risky",
      "Reply to the email asking the CEO to confirm",
      "Buy the cards but send the codes only to the CEO's known address"],
     "easy",
     "Replying to the same email 'to confirm' just talks to the attacker."),
    ("An employee finds a USB stick labelled 'Salaries 2026' in the office car park. "
     "What should they do?",
     "Hand it to the security/IT team without plugging it in anywhere",
     ["Plug it into their own laptop to identify the owner",
      "Plug it into an old spare laptop first, to be safe",
      "Format it and keep it — a free USB stick"],
     "easy",
     "'Check it on a spare machine' feels cautious and is still running untrusted hardware."),
    ("Ransomware has encrypted a file server overnight and left a payment note. Backups "
     "exist and are tested. What is the right first move?",
     "Isolate affected systems, then plan recovery from the verified backups",
     ["Pay the ransom quickly — it is the fastest path to the files",
      "Delete the ransom note and the encrypted files",
      "Restore the backups onto the still-infected server right away"],
     "medium",
     "Restoring onto a still-infected host re-encrypts the backups."),
    ("At 02:00 a user's phone gets a stream of MFA push prompts they did not initiate. "
     "What should the user do?",
     "Deny the prompts, report the incident, and change the password — it has likely "
     "been stolen",
     ["Approve one prompt so the notifications stop",
      "Turn off MFA until the morning",
      "Ignore it — without approval nothing can happen, so no action is needed"],
     "medium",
     "MFA-fatigue attacks rely on one tired approval; and the pushes themselves prove the password is compromised."),
    ("A caller claiming to be from the IT helpdesk asks an employee for their password "
     "to 'fix a mailbox sync issue'. What should the employee do?",
     "Refuse — no legitimate IT staff needs a user's password — and report the call",
     ["Give it, since the caller knew internal details",
      "Give a slightly wrong password to test the caller",
      "Ask the caller to email the request first, then share it"],
     "easy",
     None),
    ("During offboarding it turns out a developer who left three months ago still has a "
     "working VPN account. What is the right response?",
     "Disable the account immediately and review its activity since the departure",
     ["Leave it — it is useful if the developer returns",
      "Just change its password and keep it active",
      "Wait for the next quarterly access review to handle it"],
     "easy",
     None),
    ("An analyst notices the attacker deleted the local logs on a breached host. Which "
     "practice would still let the team reconstruct events?",
     "Logs shipped continuously to a separate central log server",
     ["Undeleting the local files with a recovery tool is guaranteed to work",
      "Asking the attacker's ISP for the logs",
      "Reconstructing events from users' memories"],
     "medium",
     None),
    ("A critical remote-code-execution patch is released for the company's "
     "internet-facing web server. What is the right approach?",
     "Test briefly and deploy urgently, with a rollback plan — exposure time matters",
     ["Wait for the next quarterly maintenance window",
      "Skip it — the firewall already protects the server",
      "Apply it only after another company reports being exploited"],
     "medium",
     "'The firewall protects us' fails for a service the firewall must expose."),
    ("A developer accidentally commits an API key to a public repository and force-pushes "
     "a commit removing it two minutes later. What must still happen?",
     "Revoke and rotate the key — it must be treated as compromised",
     ["Nothing — the force-push removed it from the repository",
      "Make the repository private and keep the key",
      "Rename the key so the old value stops working"],
     "medium",
     "History rewrites do not un-leak a secret: clones, forks and scrapers already have it."),
    ("Antivirus quarantines a suspicious attachment a user already opened on their "
     "workstation. The user reports it. What should IT do first?",
     "Treat the workstation as potentially compromised: isolate it and investigate",
     ["Close the ticket — the antivirus already handled it",
      "Only delete the quarantined file and move on",
      "Tell the user to run another scan tomorrow"],
     "medium",
     "'AV caught it' is the trap: quarantine after opening proves exposure, not safety."),
    ("A company laptop with full-disk encryption and a strong password is stolen. Which "
     "statement best describes the data risk?",
     "The data is most likely safe if the machine was powered off and the key is not "
     "written down",
     ["The data is certainly exposed — physical access always wins",
      "The data is safe even if the laptop was left unlocked and running",
      "The thief can read the disk by moving it to another computer regardless of "
      "encryption"],
     "hard",
     "Both extremes are wrong: FDE protects a powered-off disk; an unlocked running session defeats it."),
]


def gen_incident(rng: random.Random) -> list[dict]:
    items: list[dict] = []
    for stem, correct, distract, diff, trap in INCIDENT_TRAPS:
        prompt, choices, letter = mc(rng, stem, correct, distract)
        meta = {"trap": trap} if trap else None
        items.append(row("incident_judgment", diff, prompt, letter, "mc", choices, meta))
    return items


# --------------------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------------------


def main() -> None:
    rng = random.Random(SEED)
    items: list[dict] = []
    items += gen_crypto(rng)
    items += gen_network(rng)
    items += gen_web_security(rng)
    items += gen_forensics(rng)
    items += gen_concepts(rng)
    items += gen_incident(rng)

    rng.shuffle(items)
    final = []
    for i, item in enumerate(items, start=1):
        out_item = {"id": f"sec2-{i:04d}", "category": item["category"],
                    "difficulty": item["difficulty"], "prompt": item["prompt"],
                    "answer": item["answer"], "scorer": item["scorer"]}
        if item.get("choices"):
            out_item["choices"] = item["choices"]
        if item.get("meta"):
            out_item["meta"] = item["meta"]
        final.append(out_item)

    by_cat: dict[str, int] = {}
    by_diff: dict[str, int] = {}
    by_scorer: dict[str, int] = {}
    letters: dict[str, int] = {}
    for item in final:
        by_cat[item["category"]] = by_cat.get(item["category"], 0) + 1
        by_diff[item["difficulty"]] = by_diff.get(item["difficulty"], 0) + 1
        by_scorer[item["scorer"]] = by_scorer.get(item["scorer"], 0) + 1
        if item["scorer"] == "mc":
            letters[item["answer"]] = letters.get(item["answer"], 0) + 1

    out = L.dataset_dir(DATASET_ID)
    L.write_jsonl(out / "items.jsonl", final)

    meta = L.base_dataset_json(
        DATASET_ID,
        "Cyber security eval v2",
        "eval",
        (f"{len(final)} defensive cyber-security items: toy cryptography computed by the "
         "generator (Caesar/ROT13/XOR/textbook RSA/Diffie-Hellman), CIDR arithmetic "
         "computed with the stdlib ipaddress module, scenario-to-vulnerability-class "
         "identification, log-forensics questions computed from synthetic sshd excerpts "
         "and email Received chains, stable security-concept distinctions, and "
         "incident-response trap scenarios where the tempting answer (wipe the box, "
         "plug in the USB stick, approve the MFA push) is wrong. Identification, "
         "classification and computation only — no item asks for attack code."),
        ["items.jsonl"],
        len(final),
        "gen_eval_security_v2.py",
        default_scorer="mc",
        scoring={
            "answer_extraction": [
                "Drop everything inside <think>...</think> (and an unterminated leading <think> block).",
                "Drop markdown code fences, keeping the fenced content.",
                "If any line matches /^\\s*(?:final answer|answer)\\s*[:\\-]\\s*(.+)$/i, take the capture of the LAST such line and use only that.",
                "Strip surrounding whitespace, matching quotes, and a single trailing '.' or '!'.",
            ],
            "scorers": {
                "mc": "Multiple choice. `choices` is a list of strings; `answer` is the letter label. Accept the bare letter, 'A)', '(A)', 'A.' or the full text of the correct choice, case-insensitively.",
                "exact": "Case-insensitive comparison after collapsing internal whitespace.",
                "numeric": "Parse the last number in the extracted output; correct when within meta.tolerance (default 1e-6) of the key.",
            },
            "pass_rule": "One item is correct or incorrect; there is no partial credit. accuracy = correct / total. An item whose request failed counts as incorrect AND is reported in scores.failures and metrics.requests_failed.",
        },
        categories=sorted(by_cat),
        difficulties=["easy", "medium", "hard"],
        counts={"by_category": by_cat, "by_difficulty": by_diff, "by_scorer": by_scorer,
                "mc_letter_balance": {k: letters[k] for k in sorted(letters)}},
        seed=SEED,
        notes=[
            "Crypto, CIDR, log, epoch and key-count answers are computed by the generator from the same values that build the prompt, with round-trip asserts (RSA decrypts back to m, DH secrets agree, Caesar decrypts back to the plaintext).",
            "Scenario and concept families are hand-curated under the eval-format-v1 precedent; distractors come from the same class table so every wrong option is plausible, and trap rows carry meta.trap naming the wrong answer they are built to catch.",
            "All log excerpts use RFC 5737 documentation IPs (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and invented hostnames.",
            "Defensive scope on purpose: items ask to identify, classify, decode and compute — never to produce exploit code.",
            "created is the date this dataset was authored; the -v2 suffix marks the second-generation (hardened) eval wave.",
        ],
    )
    meta["created"] = "2026-09-01"
    L.write_json(out / "dataset.json", meta)
    L.report(DATASET_ID, len(final))
    print(f"  by_category: {by_cat}")
    print(f"  by_difficulty: {by_diff}  by_scorer: {by_scorer}")
    print(f"  letters: {dict(sorted(letters.items()))}")


if __name__ == "__main__":
    main()
