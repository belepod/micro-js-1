const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');

const pendingRequests = new Map();

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'auth-group' });

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
        clearTimeout(timeout);
        
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

const sendUserCreationRequest = async (tenantId, newUser, res) => {
  const correlationId = randomUUID();
  
  const timeout = setTimeout(() => {
    if (pendingRequests.has(correlationId)) {
        console.log(`[Auth Service] Request ${correlationId} for tenant ${tenantId} timed out.`);
        res.status(504).send('Request timed out while waiting for survey service.');
        pendingRequests.delete(correlationId);
    }
  }, 10000); 

  pendingRequests.set(correlationId, { res, timeout });

  await producer.send({
    topic: USER_CREATED_TOPIC,
    messages: [{ 
      value: JSON.stringify({
        tenantId,
        ...newUser,
        correlationId,
        replyTopic: REPLY_TOPIC
      }) 
    }],
  });

  console.log(`[Auth Service] Sent user creation request for ${newUser.username} (tenant: ${tenantId}) with correlationId ${correlationId}`);
};

module.exports = { connect, disconnect, sendUserCreationRequest };
