set -u
# Loopback rehearsal of the 7c9b9e2 Devnet run (init, native split, distributor 73/27, automatic 5/95 + 0/100 with the real
# keeper) using the Devnet build on an isolated validator (ports 19991/19008/19160/19938, its own ledger) and a throwaway
# test DB. Faucet SOL on loopback only; no Devnet or Mainnet transactions. The Localnet validator (19995) is untouched.
D=/srv/hymet-build/devnet-e2e; APP=/srv/hymet-build/devnet-7c9b9e2; cd $APP; L=$APP/work/logs; mkdir -p $L
export PATH=/srv/hymet-build/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin HOME=/srv/hymet-build
export HYMET_VALIDATOR_WORKSPACE=$APP HYMET_PROGRAM_TARGET=$D/build/target
RPC_PORT=19991; U=http://127.0.0.1:$RPC_PORT; LABEL=meteora-funded-v15; LEDGER=/srv/hymet-build/$LABEL-ledger
export VALIDATOR_LEDGER_LABEL=$LABEL VALIDATOR_RPC_PORT=$RPC_PORT VALIDATOR_GOSSIP_PORT=19008 VALIDATOR_DYNAMIC_PORT_START=19160 VALIDATOR_FAUCET_PORT=19938
DB=hymet_devnet_rehearsal; DBURL="postgresql:///$DB?host=/var/run/postgresql"
cleanup() { P=$(ss -ltnp "sport = :$RPC_PORT" | grep -o "pid=[0-9]*" | cut -d= -f2 | head -1); [ -n "$P" ] && kill $P; sleep 3; rm -rf $LEDGER; rm -f $D/devnet-proof-*.json; }
trap cleanup EXIT
rm -rf $LEDGER; node scripts/validator-fixture-start.cjs >>$L/rehearsal-validator.log 2>&1
for i in $(seq 120); do solana -u $U cluster-version >/dev/null 2>&1 && break; sleep 1; done
# Fail fast if the validator answers RPC but never produces blocks (seen once: leader stalled at slot 1).
for i in $(seq 90); do [ "$(solana -u $U slot 2>/dev/null || echo 0)" -gt 5 ] && break; sleep 1; done
[ "$(solana -u $U slot 2>/dev/null || echo 0)" -gt 5 ] || { echo "BLOCKED: rehearsal validator is not producing blocks"; exit 4; }
[ "$(solana -u $U genesis-hash)" != "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" ] || { echo "REFUSING: Mainnet genesis"; exit 1; }
DEPLOYER=$(solana-keygen pubkey $D/keys/deployer.json); SNAPSHOT=$(solana-keygen pubkey $D/keys/snapshot.json)
timeout 60 solana -u $U airdrop 10 $DEPLOYER >/dev/null && timeout 60 solana -u $U airdrop 1 FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM >/dev/null || { echo "BLOCKED: loopback airdrop did not confirm"; exit 4; }
# The 2.2.x test validator blocks new loader-v3 deploys, so the Devnet build is preloaded under the local trader key
# and handed to the Devnet test deployer (as a real Devnet deploy would leave it).
T=$(mktemp -d); node -e "const{Keypair}=require('@solana/web3.js');const c=require('node:crypto');process.stdout.write(JSON.stringify(Array.from(Keypair.fromSeed(c.createHash('sha256').update('HYMET LOCAL VALIDATOR ONLY TRADER').digest()).secretKey)))" > $T/trader.json
timeout 60 solana -u $U airdrop 1 $(solana-keygen pubkey $T/trader.json) >/dev/null || { echo "BLOCKED: loopback airdrop did not confirm"; exit 4; }
solana -u $U program set-upgrade-authority $(solana-keygen pubkey $D/keys/program.json) --upgrade-authority $T/trader.json --new-upgrade-authority $DEPLOYER --skip-new-upgrade-authority-signer-check -k $T/trader.json 2>&1 | tail -1
rm -rf $T
# Created empty (owner hymet_build) by the operator beforehand; dropped afterwards.
DATABASE_URL=$DBURL node scripts/migrate.mjs | tail -1
B0=$(solana -u $U balance $DEPLOYER --lamports | awk '{print $1}')
# PHASES selects phases (default all; "distributor" is the default phase). A fresh ledger always needs --pre-init.
for p in ${PHASES:---pre-init --native distributor --automatic}; do
  phase=$p; [ "$p" = distributor ] && phase=""
  n=rehearsal${phase:-distributor}
  [ "$phase" = "--automatic" ] && K0=$(solana -u $U balance $SNAPSHOT --lamports | awk '{print $1}') && D0=$(solana -u $U balance $DEPLOYER --lamports | awk '{print $1}')
  HYMET_DEVNET_REHEARSAL=1 DEVNET_RPC_URL=$U HYMET_DEVNET_DIR=$D HYMET_DEVNET_DATABASE_URL=$DBURL timeout 3000 node scripts/devnet-e2e.cjs $phase > $L/$n.log 2>&1
  echo "RESULT $n exit=$? pass=$(grep -c '^PASS' $L/$n.log)"
  grep -E "^FAIL|\"error\"|\"instruction\"" $L/$n.log | head -4 | cut -c1-600
done
B1=$(solana -u $U balance $DEPLOYER --lamports | awk '{print $1}'); K1=$(solana -u $U balance $SNAPSHOT --lamports | awk '{print $1}')
echo "deployer spent after deploy, all phases: $((B0-B1)) lamports; automatic phase: deployer $((D0-B1)), keeper $((K0-K1)) (incl. its 0.3 SOL funding)"
