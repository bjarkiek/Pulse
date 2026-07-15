import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

const containerName =
  process.env.AZURE_STORAGE_CONTAINER || "pulse-attachments";

export function isBlobStorageConfigured() {
  return Boolean(process.env.AZURE_STORAGE_ACCOUNT_NAME);
}

function client() {
  const account = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  if (!account) throw new Error("AZURE_STORAGE_NOT_CONFIGURED");
  return {
    account,
    service: new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    ),
  };
}

export async function createUploadUrl(storageKey: string) {
  const { account, service } = client();
  const now = new Date();
  const expiresOn = new Date(now.getTime() + 10 * 60_000);
  const delegationKey = await service.getUserDelegationKey(
    new Date(now.getTime() - 5 * 60_000),
    expiresOn,
  );
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: storageKey,
      permissions: BlobSASPermissions.parse("cw"),
      startsOn: new Date(now.getTime() - 5 * 60_000),
      expiresOn,
      protocol: SASProtocol.Https,
    },
    delegationKey,
    account,
  );
  return {
    uploadUrl: `${service.url}/${containerName}/${storageKey}?${sas}`,
    expiresAt: expiresOn.toISOString(),
  };
}

export async function downloadBlob(storageKey: string) {
  const { service } = client();
  const response = await service
    .getContainerClient(containerName)
    .getBlobClient(storageKey)
    .download();
  if (!response.readableStreamBody) throw new Error("NOT_FOUND");
  return response.readableStreamBody;
}

export async function verifyUploadedBlob(
  storageKey: string,
  expectedBytes: number,
) {
  const { service } = client();
  const properties = await service
    .getContainerClient(containerName)
    .getBlobClient(storageKey)
    .getProperties();
  if (properties.contentLength !== expectedBytes)
    throw new Error("INVALID_ATTACHMENT_SIZE");
}

export async function deleteBlob(storageKey: string) {
  const { service } = client();
  await service
    .getContainerClient(containerName)
    .getBlobClient(storageKey)
    .deleteIfExists({ deleteSnapshots: "include" });
}
