import { z } from 'zod';

export const registerSchema = z.object({
  fullName: z.string().min(3),
  nationalId: z.string().min(8).max(20).optional(),
  dateOfBirth: z.string().optional(),
  phone: z.string().min(9),
  email: z.string().email().optional(),
  password: z.string().min(8),
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
