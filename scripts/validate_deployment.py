"""Validate public deployment settings without printing credentials."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sys
from typing import Mapping


def read_env_file(path: Path) -> dict[str, str]:
    """Read the simple KEY=value / single-quoted syntax used by .env.example."""
    values = {}
    if not path.exists():
        return values
    for number, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"Invalid environment assignment at line {number}")
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
            raise ValueError(f"Invalid environment variable name at line {number}")
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError(f"Unclosed environment value at line {number}")
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


def validate_public_settings(values: Mapping[str, str]) -> None:
    domain = values.get("DOMAIN", "")
    labels = domain.split(".")
    if (
        len(domain) > 253
        or len(labels) < 2
        or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in labels
        )
        or not re.fullmatch(r"[a-z]{2,63}", labels[-1])
        or labels[-1] in {"invalid", "test", "example", "localhost", "local"}
        or domain in {"example.com", "example.org", "example.net"}
        or any(
            domain.endswith("." + name)
            for name in ("example.com", "example.org", "example.net")
        )
        or any(
            token in domain
            for token in ("your-domain", "yourdomain", "changeme", "replace-me")
        )
    ):
        raise ValueError(
            "DOMAIN must be your public DNS hostname without a scheme, port or path"
        )
    username = values.get("BASIC_AUTH_USER", "")
    if not re.fullmatch(
        r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}", username
    ) or username.lower() in {
        "changeme",
        "replace-me",
        "your-username",
        "username",
        "example",
    }:
        raise ValueError(
            "BASIC_AUTH_USER must be a chosen username containing letters, numbers, dot, dash or underscore"
        )
    password_hash = values.get("BASIC_AUTH_HASH", "")
    if not re.fullmatch(
        r"\$2[aby]\$(?:1[0-9]|2[0-9]|3[01])\$[./A-Za-z0-9]{53}", password_hash
    ):
        raise ValueError(
            "BASIC_AUTH_HASH must be a bcrypt hash with cost at least 10; generate it with caddy hash-password"
        )
    origin = values.get("TABLEWATCH_ALLOWED_ORIGINS")
    if origin is not None and origin != f"https://{domain}":
        raise ValueError(
            "TABLEWATCH_ALLOWED_ORIGINS must match the public HTTPS domain exactly"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    args = parser.parse_args()
    try:
        validate_public_settings({**read_env_file(args.env_file), **os.environ})
    except (OSError, ValueError) as error:
        print(f"Deployment configuration rejected: {error}", file=sys.stderr)
        return 1
    print(
        "Public deployment settings are valid. DNS and certificate issuance still require a running host."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
