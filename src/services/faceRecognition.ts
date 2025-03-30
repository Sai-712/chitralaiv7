import { CompareFacesCommand } from '@aws-sdk/client-rekognition';
import { S3_BUCKET_NAME, rekognitionClient } from '../config/aws';

export const compareFaces = async (sourceUrl: string, targetUrl: string): Promise<boolean> => {
  try {
    // Extract S3 keys from URLs
    const s3BucketUrl = `https://${S3_BUCKET_NAME}.s3.amazonaws.com/`;
    const sourcePath = sourceUrl.startsWith(s3BucketUrl) ? sourceUrl.substring(s3BucketUrl.length) : '';
    const targetPath = targetUrl.startsWith(s3BucketUrl) ? targetUrl.substring(s3BucketUrl.length) : '';

    if (!sourcePath || !targetPath) {
      throw new Error('Invalid S3 URLs provided');
    }

    const compareCommand = new CompareFacesCommand({
      SourceImage: {
        S3Object: { Bucket: S3_BUCKET_NAME, Name: sourcePath },
      },
      TargetImage: {
        S3Object: { Bucket: S3_BUCKET_NAME, Name: targetPath },
      },
      SimilarityThreshold: 80,
      QualityFilter: "HIGH"
    });

    const compareResponse = await rekognitionClient.send(compareCommand);

    return !!(compareResponse.FaceMatches && compareResponse.FaceMatches.length > 0);
  } catch (error) {
    console.error('Error comparing faces:', error);
    return false;
  }
}; 