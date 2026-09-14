import { defineConfig } from 'vitest/config';

// Paquete aislado: sus tests NO se mezclan con los del proyecto Next (cuyo
// vitest solo incluye `src/**`). Se ejecutan con el vitest hoisteado del repo.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
