const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER], // e.g., 'kafka:9092'
});

const producer = kafka.producer();

const sendMessage = async (topic, message) => {
  try {
    await producer.connect();
    await producer.send({
      topic,
      messages: [{ value: JSON.stringify(message) }],
    });
    console.log('Message sent successfully:', message);
  } catch (error) {
    console.error('Error sending message to Kafka:', error);
  } finally {
    await producer.disconnect();
  }
};

module.exports = { sendMessage };
