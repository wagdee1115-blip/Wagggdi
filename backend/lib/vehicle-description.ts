import { z } from 'zod';
import { db } from './db';
import { requireProviderEndpoint } from './provider-endpoint';
import { readBoundedResponseText } from './http-bounds';

export interface VehicleDescriptionProvider {
  name: string;
  configured: boolean;
  generate(input: Record<string, unknown>): Promise<string>;
}

class UnconfiguredVehicleDescriptionProvider implements VehicleDescriptionProvider {
  name = 'AI_DESCRIPTION_NOT_CONFIGURED';
  configured = false;
  async generate(): Promise<string> { throw new Error('NOT_CONFIGURED:AI_DESCRIPTION_PROVIDER_REQUIRED'); }
}

const responseSchema = z.object({ description: z.string().trim().min(20).max(5_000) }).strict();

function provider(): VehicleDescriptionProvider {
  const rawUrl = process.env.AI_DESCRIPTION_PROVIDER_URL;
  const secret = process.env.AI_DESCRIPTION_PROVIDER_SECRET?.trim();
  if (!rawUrl || !secret) return new UnconfiguredVehicleDescriptionProvider();
  const url = requireProviderEndpoint(rawUrl, 'AI_DESCRIPTION_PROVIDER');
  return {
    name: 'AI_DESCRIPTION',
    configured: true,
    async generate(input) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ facts: input, instruction: 'اكتب وصفًا عربيًا موجزًا اعتمادًا على الحقائق المقدمة فقط. لا تخترع معلومة، ولا تضف روابط أو HTML أو بيانات اتصال.' }),
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
          cache: 'no-store',
        });
      } catch {
        throw new Error('AI_DESCRIPTION_PROVIDER_UNAVAILABLE');
      }
      if (!response.ok) throw new Error('AI_DESCRIPTION_PROVIDER_FAILED');
      const body = await readBoundedResponseText(response, 64 * 1024, 'AI_DESCRIPTION_PROVIDER_INVALID_RESPONSE');
      if (!body) throw new Error('AI_DESCRIPTION_PROVIDER_INVALID_RESPONSE');
      let json: unknown;
      try { json = JSON.parse(body); } catch { throw new Error('AI_DESCRIPTION_PROVIDER_INVALID_RESPONSE'); }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) throw new Error('AI_DESCRIPTION_PROVIDER_INVALID_RESPONSE');
      return parsed.data.description;
    },
  };
}

export async function generateVehicleDescription(params: { vehicleId: string; userId: string; additionalNotes?: string }) {
  const vehicle = await db.vehicle.findUnique({
    where: { id: params.vehicleId },
    select: {
      ownerId: true,
      make: true,
      model: true,
      year: true,
      mileage: true,
      transmission: true,
      fuelType: true,
      color: true,
      city: true,
      inspections: { select: { status: true, inspectionDate: true, expiryDate: true, result: true }, orderBy: { inspectionDate: 'desc' }, take: 1 },
      insurances: { select: { provider: true, status: true, startDate: true, endDate: true }, orderBy: { endDate: 'desc' }, take: 1 },
    },
  });
  if (!vehicle || vehicle.ownerId !== params.userId) throw new Error('FORBIDDEN');
  return provider().generate({
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    mileage: vehicle.mileage,
    transmission: vehicle.transmission,
    fuelType: vehicle.fuelType,
    color: vehicle.color,
    city: vehicle.city,
    inspection: vehicle.inspections[0] ?? null,
    insurance: vehicle.insurances[0] ?? null,
    additionalNotes: params.additionalNotes?.trim() || null,
  });
}
