import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const region = import.meta.env.VITE_AWS_REGION;
const accessKeyId = import.meta.env.VITE_AWS_ACCESS_KEY_ID;
const secretAccessKey = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY;

// Initialize the DynamoDB client
const client = new DynamoDBClient({
    region,
    credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey: secretAccessKey || ''
    }
});

// Create a document client for easier interaction with DynamoDB
export const docClient = DynamoDBDocumentClient.from(client);

// Table name for storing user credentials
export const USERS_TABLE = 'Users';

// Function to store user credentials
export const storeUserCredentials = async (userData: {
    userId: string;
    email: string;
    name: string;
    mobile: string;
    role?: string | null;
    createdEvents?: string[];
}) => {
    try {
        // If createdEvents is provided, use UpdateCommand to append to the array
        if (userData.createdEvents && userData.createdEvents.length > 0) {
            // Need to check if user already exists and if we need to update or create
            const existingUser = await getUserByEmail(userData.userId);
            
            // If user exists, we'll append to the array
            if (existingUser) {
                console.log('User exists, updating with new createdEvents:', userData.createdEvents);
                
                // Update only specific fields while preserving others
                const updateCommand = new UpdateCommand({
                    TableName: USERS_TABLE,
                    Key: {
                        userId: userData.userId
                    },
                    UpdateExpression: 'SET updatedAt = :updatedAt, #role = :role, #name = :name, #mobile = :mobile',
                    ExpressionAttributeValues: {
                        ':updatedAt': new Date().toISOString(),
                        ':role': userData.role || existingUser.role || null,
                        ':name': userData.name,
                        ':mobile': userData.mobile
                    },
                    ExpressionAttributeNames: {
                        '#role': 'role',
                        '#name': 'name',
                        '#mobile': 'mobile'
                    }
                });
                
                // Execute the update command for user info
                await docClient.send(updateCommand);
                
                // Now handle the createdEvents array separately
                // We need to update the createdEvents array while avoiding duplicates
                let updatedEventIds = [...userData.createdEvents];
                
                // If user already has createdEvents, merge them
                if (existingUser.createdEvents && Array.isArray(existingUser.createdEvents)) {
                    // Create a Set to automatically remove duplicates
                    const eventIdSet = new Set([...existingUser.createdEvents, ...userData.createdEvents]);
                    updatedEventIds = Array.from(eventIdSet);
                }
                
                console.log('Final createdEvents array after merging:', updatedEventIds);
                
                // Update the createdEvents array
                const eventUpdateCommand = new UpdateCommand({
                    TableName: USERS_TABLE,
                    Key: {
                        userId: userData.userId
                    },
                    UpdateExpression: 'SET createdEvents = :createdEvents',
                    ExpressionAttributeValues: {
                        ':createdEvents': updatedEventIds
                    }
                });
                
                await docClient.send(eventUpdateCommand);
                return true;
            }
            
            // If user doesn't exist, create new record with all fields
            const command = new PutCommand({
                TableName: USERS_TABLE,
                Item: {
                    userId: userData.userId,
                    email: userData.email,
                    name: userData.name,
                    mobile: userData.mobile,
                    role: userData.role || null,
                    createdEvents: userData.createdEvents,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                }
            });
            
            await docClient.send(command);
            return true;
        }

        // For updates without createdEvents, use PutCommand but preserve existing createdEvents
        const existingUser = await getUserByEmail(userData.userId);
        
        const command = new PutCommand({
            TableName: USERS_TABLE,
            Item: {
                userId: userData.userId,
                email: userData.email,
                name: userData.name,
                mobile: userData.mobile,
                role: userData.role || null,
                createdEvents: existingUser?.createdEvents || null,
                createdAt: existingUser?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        });

        await docClient.send(command);
        return true;
    } catch (error) {
        console.error('Error storing user credentials:', error);
        return false;
    }
};

// Function to get user credentials by email
export const getUserByEmail = async (email: string) => {
    const command = new GetCommand({
        TableName: USERS_TABLE,
        Key: {
            userId: email // Using email as userId based on how storeUserCredentials is implemented
        }
    });

    try {
        console.log(`Getting user by email: ${email}`);
        const response = await docClient.send(command);
        console.log('DynamoDB response:', response);
        return response.Item;
    } catch (error) {
        console.error('Error getting user credentials:', error);
        return null;
    }
};

// Function to query user by email since email might not be the primary key
export const queryUserByEmail = async (email: string) => {
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    
    const command = new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: 'email = :email',
        ExpressionAttributeValues: {
            ':email': email
        },
        Limit: 1
    });

    try {
        const response = await docClient.send(command);
        return response.Items?.[0] || null;
    } catch (error) {
        console.error('Error scanning for user by email:', error);
        return null;
    }
};