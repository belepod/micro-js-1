const { Kafka } = require('kafkajs');
const db = require('./db');

const kafka = new Kafka({
  clientId: 'survey-service',
  brokers: [process.env.KAFKA_BROKER],
});

const consumer = kafka.consumer({ groupId: 'survey-group' });
const USER_CREATED_TOPIC = 'user-created';

const runConsumer = async () => {
  await consumer.connect();
  await consumer.subscribe({ topic: USER_CREATED_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());
      console.log(`Received user created event:`, event);

      // Add user to the survey service's own database
      try {
        await db.query(
          'INSERT INTO survey_users(user_id, username) VALUES($1, $2)',
          [event.id, event.username]
        );
        console.log(`User ${event.username} added to survey database.`);
      } catch (err) {
        console.error('Error saving user to survey database', err);
      }
    },
  });
};

module.exports = { runConsumer };
