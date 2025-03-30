import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Make sure the region matches where your table is created
const region = "ap-south-1"; // Replace with your actual region

// Get the AWS credentials from environment variables
const accessKeyId = process.env.VITE_AWS_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.VITE_AWS_SECRET_ACCESS_KEY || '';

const client = new DynamoDBClient({
  region: region,
  credentials: {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey
  }
});

// Create a document client for easier interaction with DynamoDB
export const docClient = DynamoDBDocumentClient.from(client); 