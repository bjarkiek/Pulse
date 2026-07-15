import { getIdentity } from "@/lib/server/auth";
import { apiError, correlationId, json } from "@/lib/server/http";
import { toggleFollow } from "@/lib/server/idea-repository";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){const correlation=correlationId(request);try{const {id}=await context.params;let support=false;try{support=(await request.json()).support===true;}catch{/* body is optional */}return json(await toggleFollow(await getIdentity(request),id,support),{},correlation);}catch(error){return apiError(error,correlation);}}
