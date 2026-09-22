"""Run as root on the NEW pilot only, after .env is transferred with mode 600."""
import os
from pathlib import Path
import re
import socket
import subprocess

assert os.getuid() == 0 and socket.gethostname() == 'mykustomers-wa-gateway-01'
values = dict(line.split('=', 1) for line in Path('/opt/mykustomers-wa-gateway/.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
password = values['MYSQL_DATABASE_PASSWORD']
root_password = values['MYSQL_ROOT_PASSWORD']
assert re.fullmatch('[a-f0-9]{64}', password) and re.fullmatch('[a-f0-9]{64}', root_password)
# Fresh database only. No IF NOT EXISTS that could silently reuse unrelated data.
sql = f"""
CREATE DATABASE wa_akg CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wa_gateway'@'127.0.0.1' IDENTIFIED BY '{password}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON wa_akg.* TO 'wa_gateway'@'127.0.0.1';
ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '{root_password}';
"""
result = subprocess.run(['mysql', '--protocol=socket'], input=sql, text=True, capture_output=True)
if result.returncode:
    raise SystemExit('Database bootstrap failed; diagnostic output suppressed to protect credentials')
fd = os.open('/root/.my.cnf', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('[client]\nuser=root\npassword=' + root_password + '\nprotocol=socket\n')
print('Dedicated database and bounded local user initialized; passwords suppressed')
