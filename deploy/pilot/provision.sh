#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
test "$(hostname)" = mykustomers-wa-gateway-01
test -f /etc/os-release
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04
if ! swapon --show --noheadings | grep -q .; then
    test ! -e /swapfile
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-wa-gateway.conf
sysctl --system >/dev/null
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade --with-new-pkgs -y --no-remove
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git mysql-server nginx ufw fail2ban unattended-upgrades
if ! id mykustomers >/dev/null 2>&1; then
    adduser --disabled-password --gecos '' mykustomers
    usermod -aG sudo mykustomers
    install -d -m 700 -o mykustomers -g mykustomers /home/mykustomers/.ssh
    install -m 600 -o mykustomers -g mykustomers /root/.ssh/authorized_keys /home/mykustomers/.ssh/authorized_keys
    echo 'mykustomers ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/mykustomers
    chmod 440 /etc/sudoers.d/mykustomers
    visudo -cf /etc/sudoers.d/mykustomers
fi
# Keep key-based root bootstrap until an independent sudo SSH session succeeds.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-wa-gateway.conf
install -d -m 755 /run/sshd
sshd -t
systemctl reload-or-restart ssh
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
printf '[sshd]\nenabled=true\nbackend=systemd\nmaxretry=5\nbantime=1h\n' > /etc/fail2ban/jail.d/wa-gateway.conf
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=64M\nRuntimeMaxUse=32M\nMaxRetentionSec=7day\n' > /etc/systemd/journald.conf.d/wa-gateway.conf
systemctl restart systemd-journald
systemctl enable --now fail2ban mysql nginx
install -d -m 750 -o mykustomers -g mykustomers /opt/mykustomers-wa-gateway
echo 'Bootstrap ready. Confirm a separate mykustomers sudo SSH session before disabling root login.'
