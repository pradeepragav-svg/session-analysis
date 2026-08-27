"""Standalone Superset SQL Lab client (LDAP login + CSRF + paginated execute).

This mirrors the auth flow used interactively via the superset-mcp tool, but as
a plain script dependency so pull_and_load.py can run unattended (a scheduled
job can't depend on an interactive agent session).
"""
import requests

import config


class SupersetClient:
    def __init__(self):
        self.session = requests.Session()
        self.base_url = config.SUPERSET_URL.rstrip("/")
        self.access_token = None
        self.csrf_token = None

    def login(self):
        resp = self.session.post(
            f"{self.base_url}/api/v1/security/login",
            json={
                "username": config.SUPERSET_USER,
                "password": config.SUPERSET_PASSWORD,
                "provider": "ldap",
                "refresh": True,
            },
        )
        resp.raise_for_status()
        self.access_token = resp.json()["access_token"]

        resp = self.session.get(
            f"{self.base_url}/api/v1/security/csrf_token/",
            headers={"Authorization": f"Bearer {self.access_token}"},
        )
        resp.raise_for_status()
        self.csrf_token = resp.json()["result"]

    def _headers(self):
        return {
            "Authorization": f"Bearer {self.access_token}",
            "X-CSRFToken": self.csrf_token,
            "Referer": self.base_url,
        }

    def query(self, sql, db_id, schema="wfx_olap2"):
        """Execute one SQL Lab query, returns (columns, rows)."""
        resp = self.session.post(
            f"{self.base_url}/api/v1/sqllab/execute/",
            headers=self._headers(),
            json={
                "database_id": db_id,
                "sql": sql,
                "schema": schema,
                "runAsync": False,
                "select_as_cta": False,
            },
        )
        resp.raise_for_status()
        body = resp.json()
        columns = [c["name"] for c in body["columns"]]
        return columns, body["data"]

    def query_paginated(self, sql, db_id, schema="wfx_olap2", page_size=10000):
        """Yield rows across LIMIT/OFFSET pages until a short page is returned."""
        offset = 0
        while True:
            paged_sql = f"{sql} LIMIT {page_size} OFFSET {offset}"
            columns, rows = self.query(paged_sql, db_id, schema=schema)
            for row in rows:
                yield row
            if len(rows) < page_size:
                return
            offset += page_size
