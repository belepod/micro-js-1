const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'tenant-manager',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();

// --- Define all topics this service can produce ---
const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';

const connect = async () => {
  await producer.connect();
};

const disconnect = async () => {
  await producer.disconnect();
};

const sendTenantCreatedEvent = async (tenantId) => {
  await producer.send({
    topic: TENANT_CREATED_TOPIC,
    messages: [{ value: JSON.stringify({ tenantId }) }],
  });
  console.log(`[Tenant Manager] Published tenant-created event for: ${tenantId}`);
};

// --- NEW function for deletion ---
const sendTenantDeletedEvent = async (tenantId) => {
  await producer.send({
    topic: TENANT_DELETED_TOPIC,
    messages: [{ value: JSON.stringify({ tenantId }) }],
  });
  console.log(`[Tenant Manager] Published tenant-deleted event for: ${tenantId}`);
};

// --- NEW function for renaming ---
const sendTenantRenamedEvent = async (oldTenantId, newTenantId) => {
  await producer.send({
    topic: TENANT_RENAMED_TOPIC,
    messages: [{ value: JSON.stringify({ oldTenantId, newTenantId }) }],
  });
  console.log(`[Tenant Manager] Published tenant-renamed event from '${oldTenantId}' to '${newTenantId}'`);
};


module.exports = { 
  connect, 
  disconnect, 
  sendTenantCreatedEvent,
  sendTenantDeletedEvent, // Export new function
  sendTenantRenamedEvent  // Export new function
};
