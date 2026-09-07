import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';

const loadConfig = async (
  env: Partial<Record<'QUEUE_HOST' | 'QUEUE_PORT', string>> = {},
): Promise<ConfigType<typeof queueConfig>> => {
  delete process.env.QUEUE_HOST;
  delete process.env.QUEUE_PORT;
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [queueConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return config;
};

describe('queueConfig', () => {
  afterEach(() => {
    delete process.env.QUEUE_HOST;
    delete process.env.QUEUE_PORT;
  });

  it('should default host to valkey and port to 6379', async () => {
    const config = await loadConfig();
    expect(config.host).toBe('valkey');
    expect(config.port).toBe(6379);
  });

  it('should read host and port from the environment', async () => {
    const config = await loadConfig({
      QUEUE_HOST: 'custom-queue-host',
      QUEUE_PORT: '7000',
    });
    expect(config.host).toBe('custom-queue-host');
    expect(config.port).toBe(7000);
  });
});
