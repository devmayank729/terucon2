"""`python -m terucon_catalogue ...` runs the command line (see cli.py)."""
import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
