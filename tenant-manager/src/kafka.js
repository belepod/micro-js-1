const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'tenant-manager',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const TENANT_CREATED_TOPIC = 'tenant-created';

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

module.exports = { connect, disconnect, sendTenantCreatedEvent };
