import type { Logger } from "pino";
import type { Tenant } from "./lib/engine";

declare global {
  namespace Express {
    interface Request {
      log: Logger;
      tenant?: Tenant;
    }
    interface Response {
      set(header: string): Response;
      set(header: string, value: string): Response;
      send(body: any): Response;
      status(code: number): Response;
    }
  }
}

export {};
