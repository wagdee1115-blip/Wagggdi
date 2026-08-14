import { z } from 'zod';

export const registerSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  phone: z.string().trim().regex(/^\+?[0-9]{9,15}$/),
  email: z.string().trim().email().max(254).toLowerCase().optional(),
  password: z.string().min(10).max(200),
});

export const vehicleSchema = z.object({
  plateNumber: z.string().min(2),
  vin: z.string().min(10),
  make: z.string(),
  model: z.string(),
  year: z.number().min(1980).max(2027),
  price: z.number().positive(),
  mileage: z.number().min(0),
  transmission: z.enum(['AUTO','MANUAL']),
  fuelType: z.enum(['PETROL','DIESEL','HYBRID','ELECTRIC']),
  color: z.string(),
  city: z.string(),
});
