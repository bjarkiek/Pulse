import { taxonomyInputSchema } from "@/lib/contracts";
import { readInput } from "@/lib/server/validation";
import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listTaxonomy, saveTaxonomy } from "@/lib/server/taxonomy-repository";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      { items: await listTaxonomy(await getIdentity(request)) },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    return json(
      {
        item: await saveTaxonomy(
          await getIdentity(request),
          await readInput(request, taxonomyInputSchema),
        ),
      },
      {},
      id,
    );
  } catch (error) {
    return apiError(error, id);
  }
}
