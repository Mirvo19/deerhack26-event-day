"""one-off script, makes an admin user. no signup in the app so this is it.
run: python seed_admin.py organizer@example.com 'StrongPass123!'"""
import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if len(sys.argv) != 3:
    print("usage: python seed_admin.py <email> <password>")
    sys.exit(1)
email, password = sys.argv[1], sys.argv[2]

r = requests.post(
    f"{URL}/auth/v1/admin/users",
    headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}",
             "Content-Type": "application/json"},
    json={"email": email, "password": password, "email_confirm": True,
          "user_metadata": {"role": "deerhack-admin"}},
    timeout=15,
)
print(r.status_code, r.text[:500])
