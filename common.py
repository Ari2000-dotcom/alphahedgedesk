"""Shared tick logging so every broker writes the same CSV format."""

import csv
import json
import time
from pathlib import Path

FIELDS = ["recv_ns", "broker", "symbol", "ltp", "ltq", "volume", "exch_ltt"]
DATA_DIR = Path(__file__).parent / "data"


def load_instruments(path: str | None) -> list[dict] | None:
    """Option list written by build_options.py, or None for the default futures-only run."""
    return json.loads(Path(path).read_text()) if path else None


class TickLogger:
    def __init__(self, broker: str):
        DATA_DIR.mkdir(exist_ok=True)
        self.broker = broker
        self.path = DATA_DIR / f"ticks_{broker}_{time.strftime('%Y%m%d_%H%M%S')}.csv"
        self._f = open(self.path, "w", newline="")
        self._w = csv.writer(self._f)
        self._w.writerow(FIELDS)
        self.count = 0

    def log(self, recv_ns: int, symbol: str, ltp, ltq=None, volume=None, exch_ltt=None):
        self._w.writerow([recv_ns, self.broker, symbol, ltp, ltq, volume, exch_ltt])
        self.count += 1
        # Flush every tick so live_chart.py can tail the file in real time.
        self._f.flush()

    def close(self):
        self._f.flush()
        self._f.close()
