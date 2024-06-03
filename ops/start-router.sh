#!/usr/bin/env bash
set -e

stack="router"
root=$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." >/dev/null 2>&1 && pwd )
project=$(grep -m 1 '"name":' "$root/package.json" | cut -d '"' -f 4)

docker swarm init 2> /dev/null || true
docker network create --attachable --driver overlay "$project" 2> /dev/null || true

#if grep -qs "$stack" <<<"$(docker stack ls --format '{{.Name}}')"
#then echo "A $stack stack is already running" && exit 0;
#fi

####################
# Load config

if [[ ! -f "$root/node.config.json" ]]
then cp "$root/ops/config/node.default.json" "$root/node.config.json"
fi
if [[ ! -f "$root/router.config.json" ]]
then cp "$root/ops/config/router.default.json" "$root/router.config.json"
fi

config=$(
  cat "$root/node.config.json" "$root/router.config.json" \
  | jq -s '.[0] + .[1] + .[2] + .[3]'
)

function getConfig {
  value=$(echo "$config" | jq ".$1" | tr -d '"')
  if [[ "$value" == "null" ]]
  then echo ""
  else echo "$value"
  fi
}

admin_token=$(getConfig adminToken)
aws_access_id=$(getConfig awsAccessId)
aws_access_key=$(getConfig awsAccessKey)
database_url=$(getConfig databaseUrl)
messaging_url=$(getConfig messagingUrl)
mnemonic=$(getConfig mnemonic)
production=$(getConfig production)
public_port=$(getConfig port)
logdna_key=$(getConfig logDnaKey)
logdna_tags=$(getConfig logDnaTags)

chain_providers=$(echo "$config" | jq '.chainProviders' | tr -d '\n\r ')
default_providers=$(jq '.chainProviders' "$root/ops/config/node.default.json" | tr -d '\n\r ')
if [[ "$chain_providers" == "$default_providers" ]]
then use_local_evms=true
else use_local_evms=false
fi

if [[ "$production" == "true" ]]
then
  # If we're on the prod branch then use the release semvar, otherwise use the commit hash
  if [[ "$(git rev-parse --abbrev-ref HEAD)" == "prod" || "${GITHUB_REF##*/}" == "prod" ]]
  then version=$(grep -m 1 '"version":' package.json | cut -d '"' -f 4)
  else version=$(git rev-parse HEAD | head -c 8)
  fi
else version="latest"
fi

common="networks:
      - '$project'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'"

####################
# Start up dependency stacks

if [[ "$use_local_evms" == "true" ]]
then bash "$root/ops/start-chains.sh"
fi
if [[ -z "$messaging_url" ]]
then bash "$root/ops/start-messaging.sh"
fi

echo
echo "Preparing to launch $stack stack w config:"
echo " - chain_providers=$chain_providers"
echo " - messaging_url=$messaging_url"
echo " - production=$production"
echo " - public_port=$public_port"
echo " - version=$version"

########################################
# Chain config

if [[ "$use_local_evms" == "true" ]]
then
  mnemonic_secret=""
  eth_mnemonic="${mnemonic:-candy maple cake sugar pudding cream honey rich smooth crumble sweet treat}"
  eth_mnemonic_file=""
  config=$(
    echo "$config" '{"chainAddresses":'"$(cat "$root/.chaindata/chain-addresses.json")"'}' \
    | jq -s '.[0] + .[1]'
  )

else
  echo "Connecting to external services: messaging=$messaging_url | chain_providers=$chain_providers"
  if [[ -n "$mnemonic" ]]
  then
    mnemonic_secret=""
    eth_mnemonic="$mnemonic"
    eth_mnemonic_file=""
  else
    mnemonic_secret="${project}_${stack}_mnemonic"
    eth_mnemonic=""
    eth_mnemonic_file="/run/secrets/$mnemonic_secret"
    if ! grep "$mnemonic_secret" <<<"$(docker secret ls --format '{{.Name}}')"
    then bash "$root/ops/save-secret.sh" "$mnemonic_secret"
    fi
  fi
fi

########################################
## Database config (postgres)

database_image="${project}_database:$version";
bash "$root/ops/pull-images.sh" "$database_image" > /dev/null

# database connection settings
pg_db="$project"
pg_user="$project"
pg_dev_port_node="5434"
pg_dev_port_router="5435"

if [[ "$production" == "true" ]]
then
  # Use a secret to store the database password
  db_secret="${project}_${stack}_database"
  if ! grep -qs "$db_secret" <<<"$(docker secret ls --format '{{.Name}}')"
  then bash "$root/ops/save-secret.sh" "$db_secret" "$(head -c 32 /dev/urandom | xxd -plain -c 32)"
  fi
  pg_password=""
  pg_password_file="/run/secrets/$db_secret"
  snapshots_dir_node="$root/.db-snapshots-node"
  snapshots_dir_router="$root/.db-snapshots-router"
  mkdir -p "$snapshots_dir_node"
  mkdir -p "$snapshots_dir_router"
  database_image_node="image: '$database_image'
    volumes:
      - 'database_node:/var/lib/postgresql/data'
      - '$snapshots_dir_node:/postgres/snapshots'
    secrets:
      - '$db_secret'"
  database_image_router="image: '$database_image'
    volumes:
      - 'database_router:/var/lib/postgresql/data'
      - '$snapshots_dir_router:/postgres/snapshots'
    secrets:
      - '$db_secret'"

else
  # Pass in a dummy password via env vars
  db_secret=""
  pg_password="$project"
  pg_password_file=""
  database_image_node="image: '$database_image'
    ports:
      - '$pg_dev_port_node:5432'"
  database_image_router="image: '$database_image'
    ports:
      - '$pg_dev_port_router:5432'"
  echo "${stack}_database_node will be exposed on *:$pg_dev_port_node"
  echo "${stack}_database_router will be exposed on *:$pg_dev_port_router"
fi

########################################
## Node config

node_internal_port="8000"
node_public_port="${public_port:-8002}"
if [[ $production == "true" ]]
then
  node_image_name="${project}_node:$version"
  node_image="image: '$node_image_name'
    ports:
      - '$node_public_port:$node_internal_port'"
else
  node_image_name="${project}_builder:$version";
  node_image="image: '$node_image_name'
    entrypoint: 'bash modules/server-node/ops/entry.sh'
    volumes:
      - '$root:/app'
    ports:
      - '$node_public_port:$node_internal_port'"
  echo "${stack}_node will be exposed on *:$node_public_port"
fi
bash "$root/ops/pull-images.sh" "$node_image_name" > /dev/null

# Add whichever secrets we're using to the node's service config
if [[ -n "$db_secret" || -n "$mnemonic_secret" ]]
then
  node_image="$node_image
    secrets:"
  if [[ -n "$db_secret" ]]
  then node_image="$node_image
      - '$db_secret'"
  fi
  if [[ -n "$mnemonic_secret" ]]
  then node_image="$node_image
      - '$mnemonic_secret'"
  fi
fi

########################################
## Router config

router_internal_port="9002"
# change so it dosen't conflict with portainer (revert)
router_public_port="9002"
public_url="http://127.0.0.1:$router_public_port/ping"
if [[ $production == "true" ]]
then
  router_image_name="${project}_router:$version"
  router_image="image: '$router_image_name'
    ports:
      - '$router_public_port:$router_internal_port'"
else
  router_image_name="${project}_builder:$version";
  router_image="image: '$router_image_name'
    entrypoint: 'bash modules/router/ops/entry.sh'
    volumes:
      - '$root:/app'
    ports:
      - '$router_public_port:$router_internal_port'"
  echo "${stack}_router will be exposed on *:$router_public_port"
fi
bash "$root/ops/pull-images.sh" "$router_image_name" > /dev/null

# Add whichever secrets we're using to the router's service config
if [[ -n "$db_secret" || -n "$mnemonic_secret" ]]
then
  router_image="$router_image
    secrets:"
  if [[ -n "$db_secret" ]]
  then router_image="$router_image
      - '$db_secret'"
  fi
  if [[ -n "$mnemonic_secret" ]]
  then router_image="$router_image
      - '$mnemonic_secret'"
  fi
fi

####################
# Observability tools config

grafana_image="grafana/grafana:latest"
bash "$root/ops/pull-images.sh" "$grafana_image" > /dev/null

prometheus_image="prom/prometheus:latest"
bash "$root/ops/pull-images.sh" "$prometheus_image" > /dev/null

cadvisor_image="gcr.io/google-containers/cadvisor:latest"
bash "$root/ops/pull-images.sh" "$cadvisor_image" > /dev/null

# To save time, only pull logdna image if it will be used
if [ -n "$logdna_key" ]
then
  logdna_image="logdna/logspout:v1.2.0"
  bash "$root/ops/pull-images.sh" "$logdna_image" > /dev/null
fi

prometheus_services="prometheus:
    image: $prometheus_image
    $common
    ports:
      - 9090:9090
    command:
      - --config.file=/etc/prometheus/prometheus.yml
    volumes:
      - $root/ops/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus:/prometheus

  cadvisor:
    $common
    image: $cadvisor_image
    ports:
      - 8081:8080
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:rw
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro"

grafana_service="grafana:
    image: $grafana_image
    $common
    networks:
      - $project
    ports:
      - 3008:3000
    volumes:
      - $root/ops/grafana/grafana:/etc/grafana
      - $root/ops/grafana/dashboards:/etc/dashboards
      - grafana:/var/lib/grafana"

logdna_service="logdna:
    $common
    image: '$logdna_image'
    environment:
      LOGDNA_KEY: '$logdna_key'
      TAGS: '$logdna_tags'
    volumes:
      - '/var/run/docker.sock:/var/run/docker.sock'"

# TODO we probably want to remove observability from dev env once it's working
# bc these make indra take a log longer to wake up

# Will only use logdna if in prod && API key provided in env
if [ "$production" == "true" ] && [ -n "$logdna_key" ]
then
  observability_services="$logdna_service

  $prometheus_services

  $grafana_service"
else
  observability_services="$prometheus_services

  $grafana_service"
fi

####################
# Launch stack

# Add secrets to the stack config
stack_secrets=""
if [[ -n "$db_secret" || -n "$mnemonic_secret" ]]
then
  stack_secrets="secrets:"
  if [[ -n "$db_secret" ]]
  then stack_secrets="$stack_secrets
  $db_secret:
    external: true"
  fi
  if [[ -n "$mnemonic_secret" ]]
  then stack_secrets="$stack_secrets
  $mnemonic_secret:
    external: true"
  fi
fi

docker_compose=$root/.$stack.docker-compose.yml
rm -f "$docker_compose"
cat - > "$docker_compose" <<EOF
version: '3.4'

networks:
  $project:
    external: true

$stack_secrets

volumes:
  certs:
  database_node:
  database_router:
  prometheus:
  grafana:

services:

  node:
    $common
    $node_image
    environment:
      VECTOR_CONFIG: '$(echo "$config" | tr -d '\n\r')'
      VECTOR_PROD: '$production'
      VECTOR_MNEMONIC: '$eth_mnemonic'
      VECTOR_MNEMONIC_FILE: '$eth_mnemonic_file'
      VECTOR_DATABASE_URL: '$database_url'
      VECTOR_PG_DATABASE: '$pg_db'
      VECTOR_PG_HOST: 'database-node'
      VECTOR_PG_PASSWORD: '$pg_password'
      VECTOR_PG_PASSWORD_FILE: '$pg_password_file'
      VECTOR_PG_PORT: '5432'
      VECTOR_PG_USERNAME: '$pg_user'

  router:
    $common
    $router_image
    environment:
      VECTOR_CONFIG: '$(echo "$config" | tr -d '\n\r')'
      VECTOR_PROD: '$production'
      VECTOR_NODE_URL: 'http://node:$node_internal_port'
      VECTOR_DATABASE_URL: '$database_url'
      VECTOR_PG_DATABASE: '$pg_db'
      VECTOR_PG_HOST: 'database-router'
      VECTOR_PG_PASSWORD: '$pg_password'
      VECTOR_PG_PASSWORD_FILE: '$pg_password_file'
      VECTOR_PG_PORT: '5432'
      VECTOR_PG_USERNAME: '$pg_user'
      VECTOR_MNEMONIC: '$eth_mnemonic'
      VECTOR_MNEMONIC_FILE: '$eth_mnemonic_file'

  database-node:
    $common
    $database_image_node
    environment:
      AWS_ACCESS_KEY_ID: '$aws_access_id'
      AWS_SECRET_ACCESS_KEY: '$aws_access_key'
      POSTGRES_DB: '$pg_db'
      POSTGRES_PASSWORD: '$pg_password'
      POSTGRES_PASSWORD_FILE: '$pg_password_file'
      POSTGRES_USER: '$project'
      VECTOR_ADMIN_TOKEN: '$admin_token'
      VECTOR_PROD: '$production'

  database-router:
    $common
    $database_image_router
    environment:
      AWS_ACCESS_KEY_ID: '$aws_access_id'
      AWS_SECRET_ACCESS_KEY: '$aws_access_key'
      POSTGRES_DB: '$pg_db'
      POSTGRES_PASSWORD: '$pg_password'
      POSTGRES_PASSWORD_FILE: '$pg_password_file'
      POSTGRES_USER: '$project'
      VECTOR_ADMIN_TOKEN: '$admin_token'
      VECTOR_PROD: '$production'

  $observability_services

EOF

docker stack deploy -c "$docker_compose" "$stack"

echo "The $stack stack has been deployed, waiting for $public_url to start responding.."
timeout=$(( $(date +%s) + 60 ))
while true
do
  res=$(curl -k -m 5 -s "$public_url" || true)
  if [[ -z "$res" || "$res" == "Waiting for router to wake up" ]]
  then
    if [[ "$(date +%s)" -gt "$timeout" ]]
    then echo "Timed out waiting for $public_url to respond.." && exit
    else sleep 2
    fi
  else
    echo ""
    echo "Good Morning!"
    exit;
  fi
done
