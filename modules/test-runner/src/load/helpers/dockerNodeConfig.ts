const router_server_config = {
    internal_port:"9002",
    public_port:"9002",
    public_url:`http://127.0.0.1:9002/ping`,

}

export const messaging_config =
`version: '3.4'

secrets:
  vector_jwt_public_key:
    external: true
  vector_jwt_private_key:
    external: true

networks:
  vector:
    external: true

volumes:
  certs:

services:

  auth:
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '100m'
    image: 'vector_builder:latest'
    entrypoint: 'bash modules/auth/ops/entry.sh'
    ports:
      - '5040:5040'
    volumes:
      - '/home/z/Development/vector:/app'
    environment:
      VECTOR_JWT_SIGNER_PUBLIC_KEY_FILE: '/run/secrets/vector_jwt_public_key'
      VECTOR_JWT_SIGNER_PRIVATE_KEY_FILE: '/run/secrets/vector_jwt_private_key'
      VECTOR_NATS_URL: 'nats://nats:4222'
      VECTOR_ADMIN_TOKEN: 'cxt1234'
      VECTOR_PORT: '5040'
      VECTOR_PROD: 'false'
    secrets:
      - 'vector_jwt_private_key'
      - 'vector_jwt_public_key'

  nats:
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '100m'
    image: 'vector_nats:latest'
    environment:
      JWT_SIGNER_PUBLIC_KEY_FILE: '/run/secrets/vector_jwt_public_key'
    secrets:
      - 'vector_jwt_public_key'
    ports:
      - '4222:4222'
      - '4221:4221'
`
export const node_config_json:string =
    `{
        "adminToken": "cxt1234",
        "chainAddresses": {
            "1337": {
                "channelFactoryAddress": "0x345cA3e014Aaf5dcA488057592ee47305D9B3e10",
                "testTokenAddress": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",
                "transferRegistryAddress": "0x9FBDa871d559710256a2502A2517b794B482Db40"
            },
            "1338": {
                "channelFactoryAddress": "0x345cA3e014Aaf5dcA488057592ee47305D9B3e10",
                "testTokenAddress": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",
                "transferRegistryAddress": "0x9FBDa871d559710256a2502A2517b794B482Db40"
            }
        },
        "chainProviders": {
            "1337": "http://evm_1337:8545",
            "1338": "http://evm_1338:8545"
        },
        "logLevel": "info",
        "messagingUrl": "",
        "authUrl": "172.17.0.1:4222",
        "natsUrl":"172.17.0.1:4221",
        "production": false
}
`

export const router_config:string = `{
    "allowedSwaps": [
        {
            "fromChainId": 1337,
            "toChainId": 1338,
            "fromAssetId": "0x0000000000000000000000000000000000000000",
            "toAssetId": "0x0000000000000000000000000000000000000000",
            "priceType": "hardcoded",
            "hardcodedRate": "1"
        },
        {
            "fromChainId": 1337,
            "toChainId": 1338,
            "fromAssetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",
            "toAssetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",
            "priceType": "hardcoded",
            "hardcodedRate": "1"
        }
    ],
    "messagingUrl": "",
    "production": false,
    "rebalanceProfiles": [
        {
            "chainId": 1337,
            "assetId": "0x0000000000000000000000000000000000000000",
            "reclaimThreshold": "200000000000000000",
            "target": "100000000000000000",
            "collateralizeThreshold": "50000000000000000"
        },
        {
            "chainId": 1338,
            "assetId": "0x0000000000000000000000000000000000000000",
            "reclaimThreshold": "200000000000000000",
            "target": "100000000000000000",
            "collateralizeThreshold": "50000000000000000"
        },
        {
            "chainId": 1337,
            "assetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",
            "reclaimThreshold": "2000000000000000000",
            "target": "1000000000000000000",
            "collateralizeThreshold": "500000000000000000"
        },
        {
            "chainId": 1338,
            "assetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",
            "reclaimThreshold": "2000000000000000000",
            "target": "1000000000000000000",
            "collateralizeThreshold": "500000000000000000"
        }
    ]
}
`
const eth_mnemonic = 'candy maple cake sugar pudding cream honey rich smooth crumble sweet treat'

const router_image_name = "vector_builder:0.2.2-beta.2"

export const pull_router_image_opts = ["./ops/pull-images.sh", `${router_image_name}`, '> /dev/null']


// const msg_url = `{  adminToken: cxt1234,  chainAddresses: {    1337: {      channelFactoryAddress: 0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da,      testTokenAddress: 0x9FBDa871d559710256a2502A2517b794B482Db40,      transferRegistryAddress: 0x8f0483125FCb9aaAEFA9209D8E9d7b9C8B9Fb90F,      hashlockTransferAddress: 0x345cA3e014Aaf5dcA488057592ee47305D9B3e10    },    1338: {      channelFactoryAddress: 0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da,      testTokenAddress: 0x9FBDa871d559710256a2502A2517b794B482Db40,      transferRegistryAddress: 0x8f0483125FCb9aaAEFA9209D8E9d7b9C8B9Fb90F,      hashlockTransferAddress: 0x345cA3e014Aaf5dcA488057592ee47305D9B3e10    }  },  chainProviders: {    1337: http://evm_1337:8545,    1338: http://evm_1338:8545  },  logLevel: info, messagingUrl:"", "authUrl": "172.17.0.1:4222","natsUrl":"172.17.0.1:4221", production: false,  allowedSwaps: [    {      fromChainId: 1337,      toChainId: 1338,      fromAssetId: 0x0000000000000000000000000000000000000000,      toAssetId: 0x0000000000000000000000000000000000000000,      priceType: hardcoded,      hardcodedRate: 1    },    {      fromChainId: 1337,      toChainId: 1338,      fromAssetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      toAssetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      priceType: hardcoded,      hardcodedRate: 1    }  ],  rebalanceProfiles: [    {      chainId: 1337,      assetId: 0x0000000000000000000000000000000000000000,      reclaimThreshold: 200000000000000000,      target: 100000000000000000,      collateralizeThreshold: 50000000000000000    },    {      chainId: 1338,      assetId: 0x0000000000000000000000000000000000000000,      reclaimThreshold: 200000000000000000,      target: 100000000000000000,      collateralizeThreshold: 50000000000000000    },    {      chainId: 1337,      assetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      reclaimThreshold: 2000000000000000000,      target: 1000000000000000000,      collateralizeThreshold: 500000000000000000    },    {      chainId: 1338,      assetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      reclaimThreshold: 2000000000000000000,      target: 1000000000000000000,      collateralizeThreshold: 500000000000000000    }  ]}`
const msg_url = `{  adminToken: cxt1234,  chainAddresses: {    1337: {      channelFactoryAddress: 0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da,      testTokenAddress: 0x9FBDa871d559710256a2502A2517b794B482Db40,      transferRegistryAddress: 0x8f0483125FCb9aaAEFA9209D8E9d7b9C8B9Fb90F,      hashlockTransferAddress: 0x345cA3e014Aaf5dcA488057592ee47305D9B3e10    },    1338: {      channelFactoryAddress: 0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da,      testTokenAddress: 0x9FBDa871d559710256a2502A2517b794B482Db40,      transferRegistryAddress: 0x8f0483125FCb9aaAEFA9209D8E9d7b9C8B9Fb90F,      hashlockTransferAddress: 0x345cA3e014Aaf5dcA488057592ee47305D9B3e10    }  },  chainProviders: {    1337: http://evm_1337:8545,    1338: http://evm_1338:8545  },  logLevel: info,  messagingUrl: ,  production: false,  allowedSwaps: [    {      fromChainId: 1337,      toChainId: 1338,      fromAssetId: 0x0000000000000000000000000000000000000000,      toAssetId: 0x0000000000000000000000000000000000000000,      priceType: hardcoded,      hardcodedRate: 1    },    {      fromChainId: 1337,      toChainId: 1338,      fromAssetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      toAssetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      priceType: hardcoded,      hardcodedRate: 1    }  ],  rebalanceProfiles: [    {      chainId: 1337,      assetId: 0x0000000000000000000000000000000000000000,      reclaimThreshold: 200000000000000000,      target: 100000000000000000,      collateralizeThreshold: 50000000000000000    },    {      chainId: 1338,      assetId: 0x0000000000000000000000000000000000000000,      reclaimThreshold: 200000000000000000,      target: 100000000000000000,      collateralizeThreshold: 50000000000000000    },    {      chainId: 1337,      assetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      reclaimThreshold: 2000000000000000000,      target: 1000000000000000000,      collateralizeThreshold: 500000000000000000    },    {      chainId: 1338,      assetId: 0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0,      reclaimThreshold: 2000000000000000000,      target: 1000000000000000000,      collateralizeThreshold: 500000000000000000    }  ]}`
const v_config = `{
  "adminToken": "cxt1234",
  "chainAddresses": {},
  "chainProviders": {
    "4": "https://rinkeby.infura.io"
  },
  "logLevel": "info",
  "messagingUrl": "",
  "production": false,
  "allowedSwaps": [
    {
      "fromChainId": 4,
      "toChainId": 4,
      "fromAssetId": "0x0000000000000000000000000000000000000000",
      "toAssetId": "0x0000000000000000000000000000000000000000",
      "priceType": "hardcoded",
      "hardcodedRate": "1"
    }
  ],
  "rebalanceProfiles": [
    {
      "chainId": 4,
      "assetId": "0x0000000000000000000000000000000000000000",
      "reclaimThreshold": "1",
      "target": "0",
      "collateralizeThreshold": "0"
    }
  ]
}`

const getMnemonic = () => {return `'candy maple cake sugar pudding cream honey rich smooth crumble sweet treat'`}
const getVectorConfig = ()=>{
    const n_config = node_config_json.replace(/\n/g, '');
    const r_config = router_config.replace(/\n/g, '')
    return `${n_config},${r_config}`

}

export const test_docker_compose_configuration = `version: '3.4'

networks:
  vector:
    external: true



volumes:
  certs:
  database_node:
  database_router:
  prometheus:
  grafana:

services:

  node:
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'
    image: 'vector_builder:latest'
    entrypoint: 'bash modules/server-node/ops/entry.sh'
    volumes:
      - '/home/z/Development/vector:/app'
    ports:
      
    environment:
      VECTOR_CONFIG:'${v_config}' 
      VECTOR_PROD: 'false'
      VECTOR_MNEMONIC: ${getMnemonic()}
      VECTOR_MNEMONIC_FILE: ''
      VECTOR_DATABASE_URL: ''
      VECTOR_PG_DATABASE: 'vector'
      VECTOR_PG_HOST: 'database-node'
      VECTOR_PG_PASSWORD: 'vector'
      VECTOR_PG_PASSWORD_FILE: ''
      VECTOR_PG_PORT: '5432'
      VECTOR_PG_USERNAME: 'vector'

  router:
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'
    image: 'vector_builder:latest'
    entrypoint: 'bash modules/router/ops/entry.sh'
    volumes:
      - '/home/z/Development/vector:/app'
    ports:
    
    environment:
      VECTOR_CONFIG: '{  "adminToken": "cxt1234",  "chainAddresses": {    "1337": {      "channelFactoryAddress": "0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da",      "testTokenAddress": "0x9FBDa871d559710256a2502A2517b794B482Db40",      "transferRegistryAddress": "0x8f0483125FCb9aaAEFA9209D8E9d7b9C8B9Fb90F",      "hashlockTransferAddress": "0x345cA3e014Aaf5dcA488057592ee47305D9B3e10"    },    "1338": {      "channelFactoryAddress": "0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da",      "testTokenAddress": "0x9FBDa871d559710256a2502A2517b794B482Db40",      "transferRegistryAddress": "0x8f0483125FCb9aaAEFA9209D8E9d7b9C8B9Fb90F",      "hashlockTransferAddress": "0x345cA3e014Aaf5dcA488057592ee47305D9B3e10"    }  },  "chainProviders": {    "1337": "http://evm_1337:8545",    "1338": "http://evm_1338:8545"  },  "logLevel": "info",  "messagingUrl": "",  "production": false,  "allowedSwaps": [    {      "fromChainId": 1337,      "toChainId": 1338,      "fromAssetId": "0x0000000000000000000000000000000000000000",      "toAssetId": "0x0000000000000000000000000000000000000000",      "priceType": "hardcoded",      "hardcodedRate": "1"    },    {      "fromChainId": 1337,      "toChainId": 1338,      "fromAssetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",      "toAssetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",      "priceType": "hardcoded",      "hardcodedRate": "1"    }  ],  "rebalanceProfiles": [    {      "chainId": 1337,      "assetId": "0x0000000000000000000000000000000000000000",      "reclaimThreshold": "200000000000000000",      "target": "100000000000000000",      "collateralizeThreshold": "50000000000000000"    },    {      "chainId": 1338,      "assetId": "0x0000000000000000000000000000000000000000",      "reclaimThreshold": "200000000000000000",      "target": "100000000000000000",      "collateralizeThreshold": "50000000000000000"    },    {      "chainId": 1337,      "assetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",      "reclaimThreshold": "2000000000000000000",      "target": "1000000000000000000",      "collateralizeThreshold": "500000000000000000"    },    {      "chainId": 1338,      "assetId": "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0",      "reclaimThreshold": "2000000000000000000",      "target": "1000000000000000000",      "collateralizeThreshold": "500000000000000000"    }  ]}'
      VECTOR_PROD: 'false'
      VECTOR_NODE_URL: 'http://node:8000'
      VECTOR_DATABASE_URL: ''
      VECTOR_PG_DATABASE: 'vector'
      VECTOR_PG_HOST: 'database-router'
      VECTOR_PG_PASSWORD: 'vector'
      VECTOR_PG_PASSWORD_FILE: ''
      VECTOR_PG_PORT: '5432'
      VECTOR_PG_USERNAME: 'vector'
      VECTOR_MNEMONIC: 'candy maple cake sugar pudding cream honey rich smooth crumble sweet treat'
      VECTOR_MNEMONIC_FILE: ''

  database-node:
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'
    image: 'vector_database:latest'
    ports:
      - '5434:5432'
    environment:
      AWS_ACCESS_KEY_ID: ''
      AWS_SECRET_ACCESS_KEY: ''
      POSTGRES_DB: 'vector'
      POSTGRES_PASSWORD: 'vector'
      POSTGRES_PASSWORD_FILE: ''
      POSTGRES_USER: 'vector'
      VECTOR_ADMIN_TOKEN: 'cxt1234'
      VECTOR_PROD: 'false'

  database-router:
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'
    image: 'vector_database:latest'
    ports:
      - '5435:5432'
    environment:
      AWS_ACCESS_KEY_ID: ''
      AWS_SECRET_ACCESS_KEY: ''
      POSTGRES_DB: 'vector'
      POSTGRES_PASSWORD: 'vector'
      POSTGRES_PASSWORD_FILE: ''
      POSTGRES_USER: 'vector'
      VECTOR_ADMIN_TOKEN: 'cxt1234'
      VECTOR_PROD: 'false'

  prometheus:
    image: prom/prometheus:latest
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'
    ports:
      - 9090:9090
    command:
      - --config.file=/etc/prometheus/prometheus.yml
    volumes:
      - /home/z/Development/vector/ops/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus:/prometheus

  cadvisor:
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'
    image: gcr.io/google-containers/cadvisor:latest
    ports:
      - 8081:8080
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:rw
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro

  grafana:
    image: grafana/grafana:latest
    networks:
      - 'vector'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'
    networks:
      - vector
    ports:
      - 3008:3000
    volumes:
      - /home/z/Development/vector/ops/grafana/grafana:/etc/grafana
      - /home/z/Development/vector/ops/grafana/dashboards:/etc/dashboards
      - grafana:/var/lib/grafana
`