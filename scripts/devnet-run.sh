set -u
# Devnet only, 7c9b9e2 tree. Test keys in /srv/hymet-build/devnet-e2e/keys; never Mainnet, never production keys.
# Deploys the Devnet build (if absent), then: --pre-init, --native, distributor 73/27, --automatic (5/95, 0/100, real keeper).
# Needs the empty test DB hymet_devnet (owner hymet_build). Run only with the owner's approval.
D=/srv/hymet-build/devnet-e2e; APP=/srv/hymet-build/devnet-7c9b9e2; U=https://api.devnet.solana.com; L=$APP/work/logs; mkdir -p $L
export PATH=/srv/hymet-build/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin HOME=/srv/hymet-build
DEPLOYER=$(solana-keygen pubkey $D/keys/deployer.json); PROG=$(solana-keygen pubkey $D/keys/program.json); SNAPSHOT=$(solana-keygen pubkey $D/keys/snapshot.json)
[ "$(solana -u $U genesis-hash)" = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ] || { echo "RPC is not Devnet"; exit 1; }
DBURL="postgresql:///hymet_devnet?host=/var/run/postgresql"
psql -X -At "$DBURL" -c "select current_database()" >/dev/null 2>&1 || { echo "Create the empty test DB hymet_devnet (owner hymet_build) first"; exit 1; }
NEED=${NEED_LAMPORTS:-3500000000}
HAVE=$(solana -u $U balance $DEPLOYER --lamports | awk '{print $1}')
echo "deployer $DEPLOYER has $HAVE lamports; program $PROG"
if ! solana -u $U -k $D/keys/deployer.json program show $PROG >/dev/null 2>&1; then
  [ "$HAVE" -ge "$NEED" ] || { echo "UNFUNDED: send $(( (NEED-HAVE+999999999)/1000000000 )) Devnet SOL (need $NEED lamports total) to $DEPLOYER"; exit 2; }
  SO=$D/build/target/deploy/hymet_rewards_distributor.so
  echo "deploy $(sha256sum $SO | cut -c1-16) $(stat -c %s $SO) bytes"
  solana -u $U program deploy $SO --program-id $D/keys/program.json --keypair $D/keys/deployer.json --upgrade-authority $D/keys/deployer.json \
    --with-compute-unit-price 20000 --max-sign-attempts 50 --use-rpc 2>&1 | tail -3 || exit 3
fi
solana -u $U -k $D/keys/deployer.json program show $PROG | grep -E "Authority|Data Length"
cd $APP; DATABASE_URL=$DBURL node scripts/migrate.mjs | tail -1
for phase in --pre-init --native "" --automatic; do
  echo "== devnet-e2e ${phase:-distributor}"
  HYMET_DEVNET_DIR=$D HYMET_DEVNET_DATABASE_URL=$DBURL timeout 5400 node scripts/devnet-e2e.cjs $phase > $L/devnet${phase:-distributor}.log 2>&1
  echo "RESULT ${phase:-distributor} exit=$? pass=$(grep -c '^PASS' $L/devnet${phase:-distributor}.log)"
  grep -E "^FAIL|\"error\"" $L/devnet${phase:-distributor}.log | head -5 | cut -c1-400
done
echo "deployer balance after: $(solana -u $U balance $DEPLOYER); keeper (snapshot) after: $(solana -u $U balance $SNAPSHOT)"
