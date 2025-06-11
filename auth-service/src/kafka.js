const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');

// This map will store the 'res' objects for pending HTTP requests
const pendingRequests = new Map();

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'auth-group' });

const TENANT_CREATED_TOPIC = 'tenant-created';
const USER_CREATED_TOPIC = 'user-created';
const REPLY_TOPIC = 'user-creation-status';

const connect = async () => {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topic: REPLY_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value.toString());
      const { correlationId, status } = event;

      if (pendingRequests.has(correlationId)) {
        const { res, timeout } = pendingRequests.get(correlationId);
        clearTimeout(timeout); // Very important: clear the timeout!
        
        console.log(`[Auth Service] Received reply for ${correlationId}: ${status}`);
        
        if (status === 'SUCCESS') {
          res.status(200).json({ status: 'OK', message: 'User also created in survey service.' });
        } else {
          res.status(500).json({ status: 'FAILED', message: 'User creation failed in survey service.' });
        }
        
        pendingRequests.delete(correlationId);
      }
    },
  });
};

const disconnect = async () => {
  await producer.disconnect();
  await consumer.disconnect();
};

const sendTenantCreationEvent = async (tenantId) => {
  await producer.send({
    topic: TENANT_CREATED_TOPIC,
    messages: [{ value: JSON.stringify({ tenantId }) }],
  });
  console.log(`[Auth Service] Sent tenant-created event for ${tenantId}`);
};

const sendUserCreationRequest = async (tenantId, newUser, res) => {
  // Add a debug log to be 100% sure the tenantId is arriving here
  console.log(`[Auth Service] Preparing user creation request for tenant: ${tenantId}`);

  const correlationId = randomUUID();
  
  const timeout = setTimeout(() => {
    if (pendingRequests.has(correlationId)) {
        console.log(`[Auth Service] Request ${correlationId} timed out.`);
        // Note: The 'res' here is closed over from the parent scope, which is correct.
        res.status(504).send('Request timed out while waiting for survey service.');
        pendingRequests.delete(correlationId);
    }
  }, 10000);

  pendingRequests.set(correlationId, { res, timeout });

  // The payload is now built correctly, ensuring 'tenantId' is from the function argument.
  const payload = {
    tenantId: tenantId, 
    ...newUser,
    correlationId,
    replyTopic: REPLY_TOPIC
  };

  await producer.send({
    topic: USER_CREATED_TOPIC,
    messages: [{ value: JSON.stringify(payload) }],
  });

  console.log(`[Auth Service] Sent user creation request for ${newUser.username} with correlationId ${correlationId}`);
};

module.exports = { 
  connect, 
  disconnect, 
  sendUserCreationRequest, 
  sendTenantCreationEvent
};
