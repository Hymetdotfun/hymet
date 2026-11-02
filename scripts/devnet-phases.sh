set -u
# Devnet phases only (program already deployed from the verified buffer). Each phase logs separately.
D=/srv/hymet-build/devnet-e2e; APP=/srv/hymet-build/devnet-7c9b9e2; cd $APP; L=$APP/work/logs
export PATH=/srv/hymet-build/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin HOME=/srv/hymet-build
DBURL="postgresql:///hymet_devnet?host=/var/run/postgresql"
DATABASE_URL=$DBURL node scripts/migrate.mjs | tail -1
for p in ${PHASES:---pre-init --native distributor --automatic}; do
  phase=$p; [ "$p" = distributor ] && phase=""
  HYMET_DEVNET_DIR=$D HYMET_DEVNET_DATABASE_URL=$DBURL timeout 5400 node scripts/devnet-e2e.cjs $phase > $L/devnet${phase:-distributor}.log 2>&1
  echo "RESULT ${phase:-distributor} exit=$? pass=$(grep -c '^PASS' $L/devnet${phase:-distributor}.log) $(date -u +%T)"
  grep -E "^FAIL|\"error\"" $L/devnet${phase:-distributor}.log | head -4 | cut -c1-400
done
