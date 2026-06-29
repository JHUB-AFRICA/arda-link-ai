import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { tenantMiddleware } from "./middlewares/tenant";

const app: Express = express();
// Behind the Replit reverse proxy: trust X-Forwarded-For so req.ip is the
// real client IP, not 127.0.0.1. Required for per-IP rate limiting to work.
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multi-tenant auth: enforce JWT on every non-public route
app.use(tenantMiddleware);

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok", service: "ardalink-api", version: "0.2.0" });
});

app.get("/api/whoami", (req, res) => {
  if (!req.tenant) {
    res.status(401).json({ error: "No tenant context" });
    return;
  }
  res.json({ tenant_id: req.tenant.tenant_id, sub: req.tenant.sub });
});

app.use("/api", router);

export default app;
export function createApp(): Express {
  return app;
}
