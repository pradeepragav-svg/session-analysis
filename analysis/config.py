import os

from dotenv import load_dotenv

load_dotenv()

SUPERSET_URL = os.environ.get("SUPERSET_URL", "https://reports.whatfix.com")
SUPERSET_USER = os.environ["SUPERSET_USER"]
SUPERSET_PASSWORD = os.environ["SUPERSET_PASSWORD"]
SUPERSET_DB_ID = int(os.environ.get("SUPERSET_DB_ID", "0"))

LOCAL_CH_HOST = os.environ.get("LOCAL_CH_HOST", "localhost")
LOCAL_CH_PORT = int(os.environ.get("LOCAL_CH_PORT", "8123"))
LOCAL_CH_USER = os.environ.get("LOCAL_CH_USER", "default")
LOCAL_CH_PASSWORD = os.environ.get("LOCAL_CH_PASSWORD", "local-dev-only")
LOCAL_CH_DATABASE = os.environ.get("LOCAL_CH_DATABASE", "default")

INACTIVITY_GAP_MS = int(os.environ.get("INACTIVITY_GAP_MS", "5000"))
CLOSED_SESSION_IDLE_HOURS = int(os.environ.get("CLOSED_SESSION_IDLE_HOURS", "1"))
