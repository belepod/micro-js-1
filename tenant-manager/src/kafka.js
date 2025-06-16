const { Kafka } = require('kafkajs');
const { SchemaRegistry } = require('@kafkajs/confluent-schema-registry');

const kafka = new Kafka({ clientId: 'tenant-manager', brokers: [process.env.KAFKA_BROKER] });
const producer = kafka.producer();

// Initialize the Schema Registry client for the manager service
const registry = new SchemaRegistry({ host: process.env.SCHEMA_REGISTRY_URL });

// Load all schemas that this service produces
//const tenantCreatedSchema = require('../../../avro-schemas/tenant-created.avsc');
//const tenantDeletedSchema = require('../../../avro-schemas/tenant-deleted.avsc');
//const tenantRenamedSchema = require('../../../avro-schemas/tenant-renamed.avsc');

const fs = require('fs');
const path = require('path');

// Load all schemas that this service produces
const tenantCreatedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/tenant-created.avsc'), 'utf-8')
);

const tenantDeletedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/tenant-deleted.avsc'), 'utf-8')
);

const tenantRenamedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/tenant-renamed.avsc'), 'utf-8')
);



// Define all topics this service can produce
const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';

const connect = async () => {
  await producer.connect();
};

const disconnect = async () => {
  await producer.disconnect();
};

// --- Updated functions with schema registration and encoding ---

const sendTenantCreatedEvent = async (tenantId, initialUsername, initialPassword) => {
    const subject = `${TENANT_CREATED_TOPIC}-value`;
    const payload = { tenantId, initialUsername, initialPassword };

    const { id: schemaId } = await registry.register(
        { type: 'AVRO', schema: JSON.stringify(tenantCreatedSchema) },
        { subject }
    );
    const encodedPayload = await registry.encode(schemaId, payload);

    await producer.send({
        topic: TENANT_CREATED_TOPIC,
        messages: [{ value: encodedPayload }],
    });
    console.log(`[Tenant Manager] Published tenant-created event for: ${tenantId} with initial user info.`);
};

const sendTenantDeletedEvent = async (tenantId) => {
  const message = { tenantId };
  const { id: schemaId } = await registry.register(
    { type: 'AVRO', schema: JSON.stringify(tenantDeletedSchema) },
    { subject: `${TENANT_DELETED_TOPIC}-value` }
  );
  const encodedPayload = await registry.encode(schemaId, message);
  await producer.send({
    topic: TENANT_DELETED_TOPIC,
    messages: [{ value: encodedPayload }],
  });
  console.log(`[Tenant Manager] Published ENCODED tenant-deleted event for: ${tenantId}`);
};

const sendTenantRenamedEvent = async (oldTenantId, newTenantId) => {
  const message = { oldTenantId, newTenantId };
  const { id: schemaId } = await registry.register(
    { type: 'AVRO', schema: JSON.stringify(tenantRenamedSchema) },
    { subject: `${TENANT_RENAMED_TOPIC}-value` }
  );
  const encodedPayload = await registry.encode(schemaId, message);
  await producer.send({
    topic: TENANT_RENAMED_TOPIC,
    messages: [{ value: encodedPayload }],
  });
  console.log(`[Tenant Manager] Published ENCODED tenant-renamed event from '${oldTenantId}' to '${newTenantId}'`);
};

module.exports = { 
  connect, 
  disconnect, 
  sendTenantCreatedEvent,
  sendTenantDeletedEvent,
  sendTenantRenamedEvent
};
