import React, { useState, useEffect, useCallback } from 'react';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { S3_BUCKET_NAME, s3Client, rekognitionClient } from '../config/aws';
import { CompareFacesCommand } from '@aws-sdk/client-rekognition';
import { Camera, X, Download } from 'lucide-react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { colors } from '../config/theme';
import { getEventById, getUserEvents, getEventsByUserId, getEventsByOrganizerId } from '../config/eventStorage';
import { getUserByEmail } from '../config/dynamodb';

interface UploadSelfieProps {
  setShowNavbar?: (show: boolean) => void;
}

const UploadSelfie: React.FC<UploadSelfieProps> = ({ setShowNavbar }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [selfie, setSelfie] = useState<File | null>(null);
  const [matchedImages, setMatchedImages] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [eventCoverImage, setEventCoverImage] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [videoRef, setVideoRef] = useState<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  // Helper function for building S3 paths
  const getSharedEventPath = useCallback(
    (eventId: string) => `events/shared/${eventId}`,
    []
  );

  useEffect(() => {
    const initializeComponent = async () => {
      try {
        console.log('Initializing UploadSelfie component with URL:', window.location.href);
        
        // Check if this is a direct URL access
        const isDirectAccess = !document.referrer || document.referrer.includes(window.location.origin);
        if (isDirectAccess && setShowNavbar) {
          setShowNavbar(false);
        }
        
        // Extract eventId from path, URL params or localStorage
        const pathSegments = window.location.pathname.split('/');
        const uploadSelfieIndex = pathSegments.findIndex(segment => segment === 'upload-selfie');
        let urlEventId = uploadSelfieIndex !== -1 && uploadSelfieIndex + 1 < pathSegments.length 
                       ? pathSegments[uploadSelfieIndex + 1] 
                       : null;
        
        // Check URL parameters if not found in path
        if (!urlEventId) {
          const searchParams = new URLSearchParams(window.location.search);
          urlEventId = searchParams.get('eventId');
          console.log('EventId from URL params:', urlEventId);
        }
        
        // Check localStorage as last resort (won't work in incognito)
        if (!urlEventId) {
          const storedEventId = localStorage.getItem('currentEventId');
          if (storedEventId) {
            urlEventId = storedEventId;
            console.log('EventId from localStorage:', urlEventId);
          }
        }

        if (!urlEventId) {
          console.error('No event ID found in URL path, URL parameters, or localStorage');
          throw new Error('Event ID is missing. Please ensure you have a valid event link with an eventId parameter.');
        }

        // Validate eventId format (accept both old shortid format and new 6-digit format)
        const validEventIdRegex = /^([a-zA-Z0-9_-]{7,14}|[0-9]{6})$/;
        if (!validEventIdRegex.test(urlEventId)) {
          console.error('Invalid event ID format:', urlEventId);
          throw new Error('Invalid event ID format. Please check your event link.');
        }

        console.log('Looking up event with ID:', urlEventId);
        
        // First try: Get event directly from DynamoDB
        let event = await getEventById(urlEventId);
        console.log('Direct event lookup result:', event ? 'Found' : 'Not found');
        
        // Second try: Check if event is associated with the current user
        if (!event) {
          const userEmail = localStorage.getItem('userEmail');
          if (userEmail) {
            console.log('Event not found directly. Checking user associations for:', userEmail);
            
            // Try to find the event in user's events
            const userEvents = await getUserEvents(userEmail);
            const userEvent = userEvents.find(e => e.id === urlEventId || e.eventId === urlEventId);
            if (userEvent) event = userEvent;
            
            // Try to find the event where user is organizer
            if (!event) {
              const organizerEvents = await getEventsByOrganizerId(userEmail);
              const organizerEvent = organizerEvents.find(e => e.id === urlEventId || e.eventId === urlEventId);
              if (organizerEvent) event = organizerEvent;
            }
            
            // Try to find the event where user is creator
            if (!event) {
              const creatorEvents = await getEventsByUserId(userEmail);
              const creatorEvent = creatorEvents.find(e => e.id === urlEventId || e.eventId === urlEventId);
              if (creatorEvent) event = creatorEvent;
            }
            
            // Try to look up user's created events from Users table
            if (!event) {
              const user = await getUserByEmail(userEmail);
              if (user && user.createdEvents && Array.isArray(user.createdEvents)) {
                if (user.createdEvents.includes(urlEventId)) {
                  console.log('Event found in user\'s createdEvents array');
                  // Create a minimal event object
                  event = {
                    id: urlEventId,
                    eventId: urlEventId,
                    name: 'Event',
                    date: new Date().toISOString(),
                    photoCount: 0,
                    videoCount: 0,
                    guestCount: 0,
                    userEmail: userEmail,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                  };
                }
              }
            }
          }
        }

        // If event is still not found, check if this is a shared/public access scenario
        if (!event) {
          // For shared or public access in incognito mode, create a minimal event object
          // that allows the component to initialize
          console.log('Event not found with all lookup methods. Creating a provisional object for possible public access.');
          const isSharedUrl = window.location.href.includes('shared') || 
                            window.location.href.includes('public') ||
                            (uploadSelfieIndex !== -1 && uploadSelfieIndex + 1 < pathSegments.length);
          
          if (isSharedUrl) {
            event = {
              id: urlEventId,
              eventId: urlEventId,
              name: 'Shared Event',
              date: new Date().toISOString(),
              photoCount: 0,
              videoCount: 0,
              guestCount: 0,
              userEmail: 'guest@example.com',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
          }
        }

        if (!event) {
          console.error('Could not find or create event for ID:', urlEventId);
          throw new Error('Event not found. Please check your event link or contact the event organizer.');
        }

        // Set event and session information
        setSelectedEvent(urlEventId);
        
        try {
          localStorage.setItem('currentEventId', urlEventId);
          if (!localStorage.getItem('userEmail')) {
            localStorage.setItem('sessionId', urlEventId);
            localStorage.setItem('isSharedAccess', 'true');
          }
        } catch (storageError) {
          console.warn('Unable to set localStorage (likely in incognito mode):', storageError);
          // Continue without localStorage in incognito mode
        }

        setIsInitialized(true);
        if (event.coverImage) {
          setEventCoverImage(event.coverImage);
        } else {
          await fetchEventCoverImage(urlEventId);
        }
      } catch (error: any) {
        console.error('Initialization error:', error);
        setUploadError(error.message || 'Failed to initialize selfie upload');
        
        try {
          if (localStorage.getItem('isSharedAccess') === 'true') {
            setIsInitialized(true);
            return;
          }
        } catch (e) {
          // Ignore localStorage errors in incognito
        }
        
        if (!error.message?.includes('Please log in')) {
          navigate('/events');
        }
      }
    };
    initializeComponent();
  }, [navigate, setShowNavbar]);

  // Fetch event cover image from S3
  const fetchEventCoverImage = useCallback(async (eventId: string) => {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        Prefix: `events/shared/${eventId}/cover-`
      });
      const response = await s3Client.send(listCommand);
      if (response.Contents && response.Contents.length > 0) {
        const coverImageKey = response.Contents[0].Key;
        if (coverImageKey) {
          setEventCoverImage(`https://${S3_BUCKET_NAME}.s3.amazonaws.com/${coverImageKey}`);
        }
      }
    } catch (error) {
      console.error('Error fetching event cover image:', error);
    }
  }, []);

  // Validate image file type and size
  const validateImage = useCallback((file: File) => {
    if (!file.type.match(/^image\/(jpeg|png)$/)) {
      throw new Error('Only JPEG and PNG images are supported');
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new Error('Image size must be less than 20MB');
    }
    return true;
  }, []);

  // Handle file input change
  const handleSelfieChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      try {
        // Clear previous errors
        setUploadError(null);
    
        // Check if file exists
        if (!file) {
          throw new Error('No file selected');
        }
    
        // Check file size before processing
        const maxSize = 20 * 1024 * 1024; // 20MB
        if (file.size > maxSize) {
          throw new Error(`File size (${(file.size / (1024 * 1024)).toFixed(2)}MB) exceeds the maximum limit of 20MB`);
        }
    
        // Validate file type with more comprehensive mobile camera formats
        const validTypes = ['image/jpeg', 'image/png', 'image/jpg'];
        const fileType = file.type.toLowerCase();
        if (!validTypes.some(type => fileType.includes(type.split('/')[1]))) {
          throw new Error(`Invalid file type: ${file.type}. Only JPEG and PNG images are supported`);
        }
        
        // Handle mobile camera orientation
        if (file instanceof Blob) {
          const reader = new FileReader();
          reader.onload = (e) => {
            if (e.target?.result) {
              const img = new Image();
              img.onload = () => {
                URL.revokeObjectURL(img.src);
              };
              img.src = e.target.result as string;
            }
          };
          reader.readAsDataURL(file);
        }
    
        // Compress and handle image orientation
        const compressAndOrient = async (file: File) => {
          return new Promise<File>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              if (!ctx) {
                reject(new Error('Failed to get canvas context'));
                return;
              }

              // Set proper dimensions
              const MAX_WIDTH = 1920;
              const MAX_HEIGHT = 1920;
              let width = img.width;
              let height = img.height;

              if (width > height) {
                if (width > MAX_WIDTH) {
                  height *= MAX_WIDTH / width;
                  width = MAX_WIDTH;
                }
              } else {
                if (height > MAX_HEIGHT) {
                  width *= MAX_HEIGHT / height;
                  height = MAX_HEIGHT;
                }
              }

              canvas.width = width;
              canvas.height = height;

              // Draw and compress
              ctx.drawImage(img, 0, 0, width, height);
              canvas.toBlob(
                (blob) => {
                  if (!blob) {
                    reject(new Error('Failed to compress image'));
                    return;
                  }
                  const compressedFile = new File([blob], file.name, {
                    type: 'image/jpeg',
                    lastModified: Date.now(),
                  });
                  resolve(compressedFile);
                },
                'image/jpeg',
                0.8
              );
            };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = URL.createObjectURL(file);
          });
        };

        const processedFile = await compressAndOrient(file);
        validateImage(processedFile);
        setSelfie(processedFile);
        
        // Create and validate preview URL
        const url = URL.createObjectURL(processedFile);
        if (!url) {
          throw new Error('Failed to create preview URL');
        }
        setPreviewUrl(url);

        console.log('Selfie file validated successfully:', {
          name: file.name,
          type: file.type,
          size: `${(file.size / (1024 * 1024)).toFixed(2)}MB`
        });
      } catch (error: any) {
        console.error('Error processing selfie:', error);
        setUploadError(error.message || 'Error processing selfie file');
        setSelfie(null);
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
          setPreviewUrl(null);
        }
      }
    }
  }, [validateImage, previewUrl]);

  // Compare faces using Promise.all for concurrent processing
  const compareFaces = useCallback(
    async (selfieFileName: string) => {
      try {
        const eventId = selectedEvent || localStorage.getItem('currentEventId');
        if (!eventId) throw new Error('Event ID is required for uploading a selfie.');

        const sharedEventPath = getSharedEventPath(eventId);
        const selfiePath = `${sharedEventPath}/selfies/${selfieFileName}`;
        const imagesPath = `${sharedEventPath}/images/`;

        console.log('Starting face comparison process:', {
          eventId,
          selfiePath,
          imagesPath
        });

        // List all target images in S3
        const listCommand = new ListObjectsV2Command({
          Bucket: S3_BUCKET_NAME,
          Prefix: imagesPath,
          MaxKeys: 1000
        });

        console.log('Fetching images from S3...');
        const listResponse = await s3Client.send(listCommand);
        if (!listResponse.Contents || listResponse.Contents.length === 0) {
          throw new Error('No images found in this event. Please ensure images are uploaded before attempting face comparison.');
        }

        const uploadKeys = listResponse.Contents
          .filter(item => item.Key && /\.(jpg|jpeg|png)$/i.test(item.Key))
          .map(item => item.Key!);

        if (uploadKeys.length === 0) {
          throw new Error('No valid images found in this event. Please upload some JPEG or PNG images first.');
        }

        console.log(`Found ${uploadKeys.length} images to process`);

        // Process images in smaller batches to prevent overwhelming the service
        const batchSize = 10;
        const results = [];

        for (let i = 0; i < uploadKeys.length; i += batchSize) {
          const batch = uploadKeys.slice(i, i + batchSize);
          console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(uploadKeys.length/batchSize)}`);

          const batchPromises = batch.map(async (key) => {
            try {
              const compareCommand = new CompareFacesCommand({
                SourceImage: {
                  S3Object: { Bucket: S3_BUCKET_NAME, Name: selfiePath },
                },
                TargetImage: {
                  S3Object: { Bucket: S3_BUCKET_NAME, Name: key },
                },
                SimilarityThreshold: 80,
                QualityFilter: "HIGH"
              });

              const compareResponse = await Promise.race([
                rekognitionClient.send(compareCommand),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Face comparison timed out')), 30000)
                )
              ]) as { FaceMatches?: Array<{ Similarity?: number }> };

              if (compareResponse.FaceMatches && compareResponse.FaceMatches.length > 0) {
                const bestMatch = compareResponse.FaceMatches.reduce((prev: { Similarity?: number }, current: { Similarity?: number }) =>
                  (prev.Similarity || 0) > (current.Similarity || 0) ? prev : current
                );
                console.log(`Found match in ${key} with similarity: ${bestMatch.Similarity}%`);
                return { url: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${key}`, similarity: bestMatch.Similarity || 0 };
              }
              return null;
            } catch (error) {
              console.error(`Error processing image ${key}:`, error);
              return null;
            }
          });

          const batchResults = await Promise.all(batchPromises);
          results.push(...batchResults.filter(result => result !== null));

          // Add a small delay between batches to prevent rate limiting
          if (i + batchSize < uploadKeys.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        const matchedResults = results.filter(
          (result): result is { url: string; similarity: number } =>
            result !== null && result.similarity >= 70
        );

        const sortedMatches = matchedResults.sort((a, b) => b.similarity - a.similarity);

        if (sortedMatches.length === 0) {
          throw new Error('No matching faces found in your uploaded images.');
        }

        console.log(`Face comparison completed. Found ${sortedMatches.length} matches`);

        return {
          matchedUrls: sortedMatches.map(match => match.url),
          message: `Found ${sortedMatches.length} matches out of ${uploadKeys.length} images processed.`
        };
      } catch (error: any) {
        console.error('Error in face comparison process:', error);
        throw new Error(`Face comparison failed: ${error.message}. Please try again.`);
      }
    },
    [selectedEvent, getSharedEventPath]
  );

  // Clear the selected selfie and preview URL
  const clearSelfie = useCallback(() => {
    setSelfie(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(null);
  }, [previewUrl]);

  // Upload selfie to S3 and then run face comparison
  const handleUpload = useCallback(async () => {
    if (!selfie) {
      setUploadError('Please select a selfie image first.');
      return;
    }
    setIsUploading(true);
    setUploadError(null);
    setMatchedImages([]);

    try {
      // Generate a unique filename
      const fileName = `selfie-${Date.now()}-${selfie.name}`;
      await uploadToS3(selfie, fileName);
      const result = await compareFaces(fileName);
      if (result.matchedUrls && result.matchedUrls.length > 0) {
        setMatchedImages(result.matchedUrls);
      } else {
        setUploadError('No matching faces found in your uploaded images.');
      }
      if (result.message) {
        console.log(result.message);
      }
    } catch (error: any) {
      console.error('Error during upload process:', error);
      setUploadError(error.message || 'Error uploading selfie. Please try again.');
      setMatchedImages([]);
    } finally {
      setIsUploading(false);
    }
  }, [selfie, compareFaces]);

  // Upload file to S3 using AWS SDK's multipart upload
  const uploadToS3 = useCallback(async (file: File, fileName: string) => {
    try {
      if (!selectedEvent) throw new Error('Event ID is required for uploading a selfie.');
      if (!file) throw new Error('No file selected for upload.');
      
      const isSharedLink = !localStorage.getItem('userEmail');
      const sessionId = localStorage.getItem('sessionId');
      const folderPath = `${getSharedEventPath(selectedEvent)}/selfies/${fileName}`;
      
      console.log('Starting upload to S3:', {
        fileName,
        fileSize: file.size,
        fileType: file.type,
        folderPath
      });

      const uploadParams = {
        Bucket: S3_BUCKET_NAME,
        Key: folderPath,
        Body: file,
        ContentType: file.type,
        Metadata: {
          'event-id': selectedEvent,
          'session-id': sessionId || '',
          'upload-date': new Date().toISOString()
        }
      };

      const uploadInstance = new Upload({
        client: s3Client,
        params: uploadParams,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
        queueSize: 4
      });

      uploadInstance.on('httpUploadProgress', (progress) => {
        console.log('Upload progress:', {
          loaded: progress.loaded,
          total: progress.total
        });
      });

      await uploadInstance.done();
      console.log('Upload completed successfully');
      return fileName;
    } catch (error: any) {
      console.error('Error uploading to S3:', error);
      const errorMessage = error.message || 'Unknown error occurred during upload';
      throw new Error(`Failed to upload selfie: ${errorMessage}. Please try again.`);
    }
  }, [selectedEvent, getSharedEventPath]);

  // Download a single image given its URL
  const handleDownload = useCallback(async (url: string) => {
    try {
      const response = await fetch(url, {
        mode: 'cors',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('image/')) {
        throw new Error('Invalid image format received');
      }
      const blob = await response.blob();
      const fileName = decodeURIComponent(url.split('/').pop() || 'image.jpg');
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(link.href);
    } catch (error) {
      console.error('Error downloading image:', error);
      throw error;
    }
  }, []);

  // Download all matched images sequentially with a small delay
  const handleDownloadAll = useCallback(async () => {
    let successCount = 0;
    const failedUrls: string[] = [];
    for (const url of matchedImages) {
      try {
        await handleDownload(url);
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 800));
      } catch (error) {
        console.error(`Failed to download image from ${url}:`, error);
        failedUrls.push(url);
      }
    }
    if (failedUrls.length === 0) {
      alert(`Successfully downloaded all ${successCount} images!`);
    } else {
      alert(`Downloaded ${successCount} images. Failed to download ${failedUrls.length} images. Please try again later.`);
    }
  }, [matchedImages, handleDownload]);

  const startCamera = async () => {
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      
      setStream(videoStream);
      setIsCameraActive(true);
      
      // Wait for the next render cycle to ensure video element exists
      setTimeout(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
          videoElement.srcObject = videoStream;
          videoElement.play().catch(console.error);
          setVideoRef(videoElement);
        }
      }, 100);
      
    } catch (error) {
      console.error('Error accessing camera:', error);
      alert('Could not access camera. Please make sure you have granted camera permissions.');
      setIsCameraActive(false);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setStream(null);
    }
    if (videoRef && videoRef.srcObject) {
      const tracks = (videoRef.srcObject as MediaStream).getTracks();
      tracks.forEach(track => {
        track.stop();
        track.enabled = false;
      });
      videoRef.srcObject = null;
    }
    setVideoRef(null);
    setIsCameraActive(false);
  };

  const captureImage = async () => {
    if (!videoRef || !stream) return;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.videoWidth;
      canvas.height = videoRef.videoHeight;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');
      ctx.drawImage(videoRef, 0, 0);
      
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
        }, 'image/jpeg', 0.8);
      });
      
      const cameraFile = new File([blob], 'selfie.jpg', { type: 'image/jpeg' });
      
      // Process the captured image
      setSelfie(cameraFile);
      setPreviewUrl(URL.createObjectURL(cameraFile));
      
      // Stop camera and cleanup
      stopCamera();
      if (videoRef.srcObject) {
        const tracks = (videoRef.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
        videoRef.srcObject = null;
      }
      setVideoRef(null);
      setIsCameraActive(false);
      
    } catch (error) {
      console.error('Error capturing image:', error);
      alert('Failed to capture image. Please try again.');
      // Ensure camera is stopped even if capture fails
      stopCamera();
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isCameraActive) {
      stopCamera();
    } else {
      startCamera();
    }
  };

  // Cleanup camera stream on component unmount and when navigating away
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // Add cleanup when component is hidden or user navigates away
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopCamera();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', stopCamera);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', stopCamera);
    };
  }, []);

  if (!isInitialized) {
    return (
      <div className="relative min-h-screen bg-blue-100">
        {eventCoverImage ? (
          <div className="fixed top-0 left-0 w-full h-64 bg-black">
            <img
              src={eventCoverImage}
              alt="Event Cover"
              className="w-full h-full object-cover opacity-80"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black opacity-50"></div>
          </div>
        ) : (
          <div className="w-full h-full bg-blue-100"></div>
        )}
        <div className="flex items-center justify-center min-h-screen bg-champagne bg-opacity-50 relative z-10">
          <div className="text-center p-8 bg-blue-100 rounded-lg shadow-lg">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-turquoise mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-white">
      <div className="container mx-auto px-4 py-6 sm:py-8 relative z-10">
        <div className="mb-6 sm:mb-8 flex flex-col items-center justify-center text-center">
          
        </div>

        {/* Video Background */}
        

        {/* Main Content */}
        <div className="relative z-10 container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto bg-white p-8 rounded-lg shadow-md border-2 border-blue-700">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-aquamarine">Upload Selfie</h2>
              <Link to="/" className="flex items-center text-gray-600 hover:text-gray-800"></Link>
            </div>

            {uploadError && (
              <div className="mb-4 p-3 bg-blue-100 text-blue-700 rounded-lg">
                {uploadError}
              </div>
            )}

            <div className="space-y-4">
              <div className="flex items-center justify-center w-full">
                <button
                  onClick={startCamera}
                  disabled={isCameraActive}
                  className={`w-full flex flex-col items-center px-4 py-6 rounded-lg border-2 ${
                    isCameraActive 
                    ? 'bg-gray-100 border-gray-300 cursor-not-allowed' 
                    : 'bg-blue-100 border-turquoise border-dashed cursor-pointer hover:border-aquamarine hover:bg-champagne'
                  } transition-colors duration-200`}
                >
                  <div className="flex flex-col items-center">
                    <div className={`p-3 ${
                      isCameraActive 
                      ? 'text-gray-400' 
                      : 'text-black-400'
                    }`}>
                      <Camera className={`w-8 h-8 ${isCameraActive ? 'text-gray-400' : 'text-black-400'}`} />
                    </div>
                    <div className={`mt-2 px-3 py-1 border-2 rounded-lg ${
                      isCameraActive 
                      ? 'border-gray-400 bg-gray-50' 
                      : 'border-blue-500 bg-blue-50'
                    }`}>
                      <p className={`text-sm ${isCameraActive ? 'text-gray-500' : 'text-blue-500'}`}>
                        <span className="font-semibold">
                          {isCameraActive ? 'Camera is active' : 'Open camera'}
                        </span>
                      </p>
                    </div>
                    <p className={`text-xs mt-1 ${isCameraActive ? 'text-gray-500' : 'text-blue-500'}`}>
                      {isCameraActive ? 'Use capture button below' : 'Click to start camera'}
                    </p>
                  </div>
                </button>
              </div>

              {isCameraActive && (
                <div className="relative w-full max-w-md mx-auto">
                  <video
                    autoPlay
                    playsInline
                    className="w-full rounded-lg border-4 border-blue-500"
                    style={{ transform: 'scaleX(-1)' }} // Mirror the video feed
                  />
                  <button
                    onClick={captureImage}
                    className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-blue-500 text-white rounded-full p-2 sm:p-3 hover:bg-blue-600 transition-colors shadow-lg flex items-center gap-1 sm:gap-2 text-xs sm:text-sm"
                  >
                    <Camera className="w-4 h-4 sm:w-5 sm:h-5" />
                    
                  </button>
                </div>
              )}

              {previewUrl && !isCameraActive && (
                <div className="relative w-32 h-32 mx-auto">
                  <img
                    src={previewUrl}
                    alt="Selfie preview"
                    className="w-full h-full object-cover rounded-lg"
                  />
                  <button
                    onClick={clearSelfie}
                    className="absolute -top-2 -right-2 bg-blue-500 text-white rounded-full p-1 hover:bg-blue-600 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              <button
                onClick={handleUpload}
                disabled={isUploading || !selfie}
                className={`w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium ${
                  isUploading || !selfie 
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
                  : 'text-white bg-blue-500 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
                } transition-colors duration-200`}
              >
                {isUploading ? 'Processing...' : !selfie ? 'Take a selfie first' : 'Upload Selfie'}
              </button>
            </div>

            {matchedImages.length > 0 && (
              <div className="mt-8 p-4 bg-white rounded-lg">
                <div className="flex flex-col items-center justify-center space-y-4">
                  <div className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap">
                    Found {matchedImages.length} matching images!
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 w-full">
                    {matchedImages.map((url, index) => (
                      <div key={index} className="relative group aspect-square">
                        <img
                          src={url}
                          alt={`Match ${index + 1}`}
                          className="w-full h-full object-cover rounded-2xl shadow-sm cursor-pointer"
                          onClick={() => setSelectedImage(url)}
                        />
                        <button
                          onClick={() => handleDownload(url)}
                          className="absolute bottom-2 right-2 bg-white text-black rounded-full p-2 opacity-70 group-hover:opacity-100 transition-opacity"
                          title="Download image"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {matchedImages.length > 1 && (
                    <button
                      onClick={handleDownloadAll}
                      className="mt-4 px-6 py-2 bg-blue-200 text-black rounded-md hover:bg-blue-600 hover:text-gray-800 transition-colors duration-200 flex items-center gap-2"
                    >
                      <Download className="h-4 w-4" />
                      Download All Matched Images
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Image Preview Modal */}
            {selectedImage && (
              <div 
                className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center p-4 z-50"
                onClick={() => setSelectedImage(null)}
              >
                <div 
                  className="relative bg-white rounded-lg p-4 max-w-4xl w-full mx-4"
                  onClick={e => e.stopPropagation()}
                >
                  <img
                    src={selectedImage}
                    alt="Selected match"
                    className="w-full h-auto max-h-[80vh] object-contain rounded-lg"
                  />
                  <button
                    onClick={() => setSelectedImage(null)}
                    className="absolute -top-3 -right-3 p-2 bg-white rounded-full shadow-lg hover:bg-gray-100 transition-colors"
                  >
                    <X className="w-5 h-5 text-gray-600" />
                  </button>
                  <button
                    onClick={() => handleDownload(selectedImage)}
                    className="absolute bottom-6 right-6 p-3 rounded-full bg-blue-500 text-white hover:bg-blue-600 transition-colors duration-200 flex items-center gap-2 shadow-lg"
                  >
                    <Download className="w-6 h-6" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default UploadSelfie;
