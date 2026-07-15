import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listIdeas } from "@/lib/server/idea-repository";
export async function GET(request:Request){const id=correlationId(request);try{return json({items:await listIdeas(await getIdentity(request))},{},id);}catch(error){return apiError(error,id);}}

