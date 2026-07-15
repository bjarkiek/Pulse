import { getIdentity } from "@/lib/server/auth";
import {
  addExternalLink,
  listExternalLinks,
} from "@/lib/server/external-link-repository";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json(
      { items: await listExternalLinks(await getIdentity(request), id) },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    return json(
      await addExternalLink(await getIdentity(request), id, await request.json()),
      { status: 201 },
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}
