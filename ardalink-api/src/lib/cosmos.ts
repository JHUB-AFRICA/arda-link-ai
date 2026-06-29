import { CosmosClient } from "@azure/cosmos";

let _client: CosmosClient | null = null;
let _db: ReturnType<CosmosClient["database"]> | null = null;

function client(): CosmosClient {
  if (!_client) {
    const endpoint = process.env.COSMOS_DB_ENDPOINT;
    const key = process.env.COSMOS_DB_PRIMARY_KEY;
    if (!endpoint || !key) {
      throw new Error(
        "COSMOS_DB_ENDPOINT and COSMOS_DB_PRIMARY_KEY must be set",
      );
    }
    _client = new CosmosClient({ endpoint, key });
  }
  return _client;
}

export const ardalinkDb = new Proxy(
  {} as ReturnType<CosmosClient["database"]>,
  {
    get(_target, prop) {
      if (!_db) {
        _db = client().database("ardalink");
      }
      return Reflect.get(_db, prop);
    },
  },
);
