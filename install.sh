#!/data/data/com.termux/files/usr/bin/bash
# install.sh — установка Coting в чистый Termux.
# Coting — открытый кодинг-агент для Termux/смартфонов.
# © 2026 RybinskLab (ИП Усачёв Д.Е.) — https://rybinsklab.ru
#
# Запуск на устройстве:
#   curl -fsSL https://raw.githubusercontent.com/RybinskLab/coting/main/install.sh | bash
set -e

REPO="https://github.com/RybinskLab/coting"
RAW="https://raw.githubusercontent.com/RybinskLab/coting/main"

echo "🐾 Coting — установка в Termux"
echo "──────────────────────────────"

# 1) зависимости
command -v node >/dev/null 2>&1 || { echo "→ ставлю nodejs…"; pkg install -y nodejs; }
command -v rg  >/dev/null 2>&1 || { echo "→ ставлю ripgrep…"; pkg install -y ripgrep; }
command -v git >/dev/null 2>&1 || { echo "→ ставлю git…";     pkg install -y git; }

# 2) сервер
if [ -d "$HOME/coting" ]; then
  echo "→ ~/coting уже есть — обновляю (старая копия → ~/coting.bak)"
  rm -rf "$HOME/coting.bak"
  mv "$HOME/coting" "$HOME/coting.bak"
fi
echo "→ качаю сервер из $REPO"
git clone --depth 1 "$REPO" "$HOME/coting" 2>/dev/null \
  || { curl -fsSL "$RAW/archive/refs/heads/main.tar.gz" | tar -xz -C "$HOME/" && mv "$HOME/coting-main" "$HOME/coting"; }

# 3) CLI-скрипты
mkdir -p "$HOME/bin"
cp "$HOME/coting/termux/coting"  "$HOME/bin/coting"
cp "$HOME/coting/termux/cotingd" "$HOME/bin/cotingd"
chmod +x "$HOME/bin/coting" "$HOME/bin/cotingd"

# 4) доступы: RUN_COMMAND из APK Coting (кнопка «Запустить сервер»)
mkdir -p "$HOME/.termux"
grep -q "allow-external-apps" "$HOME/.termux/termux.properties" 2>/dev/null \
  || printf "\n# Coting APK: разрешить RUN_COMMAND\nallow-external-apps=true\n" >> "$HOME/.termux/termux.properties"

# 5) доступ Termux к памяти телефона (для скриншотов агента и файлов)
[ -d "$HOME/storage/shared" ] || { echo "→ запрашиваю доступ к памяти (подтверди диалог)"; termux-setup-storage >/dev/null 2>&1 || true; }

# 6) запуск
"$HOME/bin/coting" start

echo
echo "✓ Готово! Веб-чат:  http://127.0.0.1:8395"
echo "  терминал:  coting web     — открыть чат в браузере"
echo "  терминал:  coting status  — статус"
echo "  APK Coting: кнопка «Запустить сервер в Termux» теперь работает."
echo
echo "© 2026 RybinskLab — https://rybinsklab.ru"
