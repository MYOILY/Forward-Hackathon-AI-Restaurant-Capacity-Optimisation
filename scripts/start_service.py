"""Container entry point: reject unsafe public settings before starting the service."""

import os
import sys

from validate_deployment import validate_public_settings


if __name__ == "__main__":
    if os.getenv("TABLEWATCH_PUBLIC_DEPLOYMENT") == "true":
        try:
            validate_public_settings(os.environ)
        except ValueError as error:
            print(f"Deployment configuration rejected: {error}", file=sys.stderr)
            raise SystemExit(1)
    os.execv(sys.executable, [sys.executable, "-m", "service"])
