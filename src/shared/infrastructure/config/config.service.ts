import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  get<T extends string | number | boolean>(key: string, defaultValue: T): T {
    const value = process.env[key];

    if (value === undefined || value === '') {
      return defaultValue;
    }

    if (typeof defaultValue === 'number') {
      const parsedValue = Number(value);
      return (Number.isFinite(parsedValue) ? parsedValue : defaultValue) as T;
    }

    if (typeof defaultValue === 'boolean') {
      return (value === 'true') as T;
    }

    return value as T;
  }
}
