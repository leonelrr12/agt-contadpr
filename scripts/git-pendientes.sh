#!/usr/bin/env bash
# git-pendientes.sh — ¿hay trabajo que se vería "perdido" al cambiar de rama?
#
# Producción sirve el working tree (nginx -> apps/web/public), no un artefacto
# de main: una rama con commits sin fusionar parece un cambio perdido. Este
# chequeo es de solo lectura salvo el `git fetch` (actualiza refs remotas).
#
# Uso: bash scripts/git-pendientes.sh
# Sale 1 si hay algo pendiente (cambios sin commitear, stashes o ramas con
# parches fuera de origin/main); 0 si todo está en main.

set -u
cd "$(dirname "$0")/.." || exit 2

echo "Rama actual: $(git branch --show-current)"
git fetch --all --prune --quiet 2>/dev/null || echo "⚠️  No se pudo actualizar origin (se usa el último fetch)."

pendiente=0

if [ -n "$(git status --porcelain)" ]; then
  pendiente=1
  echo "⚠️  Cambios sin commitear:"
  git status --short
else
  echo "✅ Working tree limpio."
fi

if [ -n "$(git stash list)" ]; then
  pendiente=1
  echo "⚠️  Stashes sin aplicar:"
  git stash list
fi

# Ramas con commits cuyo parche NO está en origin/main (`git cherry` marca '+').
ramas=$(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin 2>/dev/null \
  | grep -vE '^(main|origin/main|origin/HEAD)$' || true)
for b in $ramas; do
  # Si la rama existe local, no repetir su copia origin/<rama>.
  case "$b" in
    origin/*)
      local="${b#origin/}"
      git show-ref --verify --quiet "refs/heads/$local" && continue
      ;;
  esac
  n=$(git cherry origin/main "$b" 2>/dev/null | grep -c '^+' || true)
  if [ "${n:-0}" -gt 0 ]; then
    pendiente=1
    echo "⚠️  $b tiene $n commit(s) cuyo parche NO está en origin/main:"
    git cherry -v origin/main "$b" | sed -n 's/^+ /    /p'
  fi
done

if [ "$pendiente" -eq 0 ]; then
  echo "✅ Todo el trabajo de las ramas está en origin/main. Nada se pierde al cambiar de rama."
else
  echo "➡️  Antes de cambiar de rama, fusiona/abre PR de lo pendiente."
fi
exit "$pendiente"
