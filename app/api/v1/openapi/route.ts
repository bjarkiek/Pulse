import specification from "@/public/openapi.json";
import { correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  return json(specification, {}, correlationId(request));
}
