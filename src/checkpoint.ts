import Promise from 'bluebird';
import { addResolversToSchema } from '@graphql-tools/schema';
import { Knex } from 'knex';
import { Pool as PgPool } from 'pg';
import getGraphQL, { CheckpointsGraphQLObject, MetadataGraphQLObject } from './graphql';
import { GqlEntityController } from './graphql/controller';
import { BaseProvider, StarknetProvider, BlockNotFoundError } from './providers';

import { createLogger, Logger, LogLevel } from './utils/logger';
import { createKnex } from './knex';
import { AsyncMySqlPool, createMySqlPool } from './mysql';
import { createPgPool } from './pg';
import {
  ContractSourceConfig,
  CheckpointConfig,
  CheckpointOptions,
  CheckpointWriters
} from './types';
import { getContractsFromConfig } from './utils/checkpoint';
import { CheckpointRecord, CheckpointsStore, MetadataId } from './stores/checkpoints';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';

const REFRESH_INTERVAL = 7000;

export default class Checkpoint {
  public config: CheckpointConfig;
  public writer: CheckpointWriters;
  public opts?: CheckpointOptions;
  public schema: string;

  private readonly entityController: GqlEntityController;
  private readonly log: Logger;
  private readonly networkProvider: BaseProvider;

  private dbConnection: string;
  private knex: Knex;
  private mysqlPool?: AsyncMySqlPool;
  private pgPool?: PgPool;
  private checkpointsStore?: CheckpointsStore;
  private sourceContracts: string[];
  private cpBlocksCache: number[] | null;

  constructor(
    config: CheckpointConfig,
    writer: CheckpointWriters,
    schema: string,
    opts?: CheckpointOptions
  ) {
    this.config = config;
    this.writer = writer;
    this.opts = opts;
    this.schema = this.extendSchema(schema);

    this.validateConfig();

    this.entityController = new GqlEntityController(this.schema, opts);

    this.sourceContracts = getContractsFromConfig(config);
    this.cpBlocksCache = [];

    this.log = createLogger({
      base: { component: 'checkpoint' },
      level: opts?.logLevel || LogLevel.Error,
      ...(opts?.prettifyLogs
        ? {
            transport: {
              target: 'pino-pretty'
            }
          }
        : {})
    });

    const NetworkProvider = opts?.NetworkProvider || StarknetProvider;
    this.networkProvider = new NetworkProvider({ instance: this, log: this.log, abis: opts?.abis });

    const dbConnection = opts?.dbConnection || process.env.DATABASE_URL;
    if (!dbConnection) {
      throw new Error(
        'a valid connection string or DATABASE_URL environment variable is required to connect to the database'
      );
    }

    this.knex = createKnex(dbConnection);
    this.dbConnection = dbConnection;
  }

  public getBaseContext() {
    return {
      log: this.log.child({ component: 'resolver' }),
      knex: this.knex,
      mysql: this.mysql,
      pg: this.pg
    };
  }

  public getSchema() {
    const entityQueryFields = this.entityController.generateQueryFields();
    const coreQueryFields = this.entityController.generateQueryFields([
      MetadataGraphQLObject,
      CheckpointsGraphQLObject
    ]);

    const query = new GraphQLObjectType({
      name: 'Query',
      fields: {
        ...entityQueryFields,
        ...coreQueryFields
      }
    });

    return addResolversToSchema({
      schema: new GraphQLSchema({ query }),
      resolvers: this.entityController.generateEntityResolvers(entityQueryFields)
    });
  }

  /**
   * Returns an express handler that exposes a GraphQL API to query entities defined
   * in the schema.
   *
   */
  public get graphql() {
    const schema = this.getSchema();

    return getGraphQL(schema, this.getBaseContext(), this.entityController.generateSampleQuery());
  }

  /**
   * Starts the indexer.
   *
   * The indexer will invoker the respective writer functions when a contract
   * event is found.
   *
   */
  public async start() {
    this.log.debug('starting');

    const blockNum = await this.getStartBlockNum();
    return await this.next(blockNum);
  }

  /**
   * Reset will clear the last synced block informations
   * and force Checkpoint to start indexing from the start
   * block.
   *
   * This will also clear all indexed GraphQL entity records.
   *
   * This should be called when there has been a change to the GraphQL schema
   * or a change to the writer functions logic, so indexing will re-run from
   * the starting block. Also, it should be called the first time Checkpoint
   * is being initialized.
   *
   */
  public async reset() {
    this.log.debug('reset');

    await this.store.createStore();
    await this.store.setMetadata(MetadataId.LastIndexedBlock, 0);

    await this.entityController.createEntityStores(this.knex);
  }

  /**
   * Resets Checkpoint's internal tables (including checkpoints).
   *
   * Calling this function will cause next run of checkpoint to start syncing
   * from the start, block-by-block, until new checkpoints are found.
   *
   */
  public async resetMetadata() {
    this.log.debug('reset metadata');

    await this.store.resetStore();
  }

  public addSource(source: ContractSourceConfig) {
    if (!this.config.sources) this.config.sources = [];

    this.config.sources.push(source);
    this.sourceContracts = getContractsFromConfig(this.config);
    this.cpBlocksCache = [];
  }

  public executeTemplate(name: string, { contract, start }: { contract: string; start: number }) {
    const template = this.config.templates?.[name];

    if (!template) {
      this.log.warn({ name }, 'template not found');
      return;
    }

    this.addSource({
      contract,
      start,
      abi: template.abi,
      events: template.events
    });
  }

  /**
   * Registers the blocks where a contracts event can be found.
   * This will be used as a skip list for checkpoints while
   * indexing relevant blocks. Using this seed function can significantly
   * reduce the time for Checkpoint to re-index blocks.
   *
   * This should be called before the start() method is called.
   *
   */
  public async seedCheckpoints(
    checkpointBlocks: { contract: string; blocks: number[] }[]
  ): Promise<void> {
    await this.store.createStore();

    const checkpoints: CheckpointRecord[] = [];

    checkpointBlocks.forEach(cp => {
      cp.blocks.forEach(blockNumber => {
        checkpoints.push({ blockNumber, contractAddress: cp.contract });
      });
    });

    await this.store.insertCheckpoints(checkpoints);
  }

  public async setLastIndexedBlock(block: number) {
    await this.store.setMetadata(MetadataId.LastIndexedBlock, block);
  }

  public async insertCheckpoints(checkpoints: { blockNumber: number; contractAddress: string }[]) {
    await this.store.insertCheckpoints(checkpoints);
  }

  public async getWriterParams(): Promise<{
    instance: Checkpoint;
    knex: Knex;
    mysql: AsyncMySqlPool;
    pg: PgPool;
  }> {
    return {
      instance: this,
      mysql: this.mysql,
      pg: this.pg
    };
  }

  private async getStartBlockNum() {
    let start = 0;
    let lastBlock = await this.store.getMetadataNumber(MetadataId.LastIndexedBlock);
    lastBlock = lastBlock ?? 0;

    const nextBlock = lastBlock + 1;

    if (this.config.tx_fn || this.config.global_events) {
      if (this.config.start) start = this.config.start;
    } else {
      (this.config.sources || []).forEach(source => {
        start = start === 0 || start > source.start ? source.start : start;
      });
    }
    return nextBlock > start ? nextBlock : start;
  }

  private async next(blockNum: number) {
    if (!this.config.tx_fn && !this.config.global_events) {
      const checkpointBlock = await this.getNextCheckpointBlock(blockNum);
      if (checkpointBlock) blockNum = checkpointBlock;
    }

    this.log.debug({ blockNumber: blockNum }, 'next block');

    try {
      await this.networkProvider.processBlock(blockNum);

      return this.next(blockNum + 1);
    } catch (err) {
      if (this.config.optimistic_indexing && err instanceof BlockNotFoundError) {
        try {
          await this.networkProvider.processPool(blockNum);
        } catch (err) {
          this.log.error({ blockNumber: blockNum, err }, 'error occured during pool processing');
        }
      } else {
        this.log.error({ blockNumber: blockNum, err }, 'error occured during block processing');
      }

      await Promise.delay(REFRESH_INTERVAL);
      return this.next(blockNum);
    }
  }

  private async getNextCheckpointBlock(blockNum: number): Promise<number | null> {
    if (this.cpBlocksCache === null) {
      // cache is null when we can no more find a record in the database
      // so exiting early here to avoid polling the database in subsequent
      // loops.
      return null;
    }

    if (this.cpBlocksCache.length !== 0) {
      return this.cpBlocksCache.shift();
    }

    const checkpointBlocks = await this.store.getNextCheckpointBlocks(
      blockNum,
      this.sourceContracts
    );
    if (checkpointBlocks.length === 0) {
      this.log.info({ blockNumber: blockNum }, 'no more checkpoint blocks in store');
      // disabling cache to stop polling database
      this.cpBlocksCache = null;

      return null;
    }

    this.cpBlocksCache = checkpointBlocks;
    return this.cpBlocksCache.shift();
  }

  private get store(): CheckpointsStore {
    if (this.checkpointsStore) {
      return this.checkpointsStore;
    }

    return (this.checkpointsStore = new CheckpointsStore(this.knex, this.log));
  }

  /**
   * returns AsyncMySqlPool if mysql client is used, otherwise returns Proxy that
   * will notify user when used that mysql is not available with other clients
   */
  private get mysql(): AsyncMySqlPool {
    if (this.mysqlPool) {
      return this.mysqlPool;
    }

    if (this.knex.client.config.client === 'mysql') {
      this.mysqlPool = createMySqlPool(this.dbConnection);
      return this.mysqlPool;
    }

    return new Proxy(
      {},
      {
        get() {
          throw new Error('mysql is only accessible when using MySQL database.');
        }
      }
    ) as AsyncMySqlPool;
  }

  /**
   * returns pg's Pool if pg client is used, otherwise returns Proxy that
   * will notify user when used that mysql is not available with other clients
   */
  private get pg(): PgPool {
    if (this.pgPool) {
      return this.pgPool;
    }

    if (this.knex.client.config.client === 'pg') {
      this.pgPool = createPgPool(this.dbConnection);
      return this.pgPool;
    }

    return new Proxy(
      {},
      {
        get() {
          throw new Error('pg is only accessible when using PostgreSQL database.');
        }
      }
    ) as PgPool;
  }

  private extendSchema(schema: string): string {
    return `directive @derivedFrom(field: String!) on FIELD_DEFINITION
${schema}`;
  }

  private validateConfig() {
    const sources = this.config.sources ?? [];
    const templates = Object.values(this.config.templates ?? {});

    const usedAbis = [
      ...sources.map(source => source.abi),
      ...templates.map(template => template.abi)
    ].filter(abi => abi) as string[];
    const usedWriters = [
      ...sources.flatMap(source => source.events),
      ...templates.flatMap(template => template.events)
    ];

    const missingAbis = usedAbis.filter(abi => !this.opts?.abis?.[abi]);
    const missingWriters = usedWriters.filter(writer => !this.writer[writer.fn]);

    if (missingAbis.length > 0) {
      throw new Error(
        `Following ABIs are used (${missingAbis.join(', ')}), but they are missing in opts.abis`
      );
    }

    if (missingWriters.length > 0) {
      throw new Error(
        `Following writers are used (${missingWriters
          .map(writer => writer.fn)
          .join(', ')}), but they are not defined`
      );
    }
  }
}
