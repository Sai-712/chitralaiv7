import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Camera, Calendar, Image as ImageIcon, ArrowRight, X, Search, Download } from 'lucide-react';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { S3_BUCKET_NAME, s3Client, rekognitionClient } from '../config/aws';
import { CompareFacesCommand } from '@aws-sdk/client-rekognition';
import { getEventById } from '../config/eventStorage';
import { storeAttendeeImageData } from '../config/attendeeStorage';
import { compareFaces } from '../services/faceRecognition';

interface Event {
  eventId: string;
  eventName: string;
  eventDate: string;
  thumbnailUrl: string;
  coverImage?: string;
}

interface MatchingImage {
  imageId: string;
  eventId: string;
  eventName: string;
  imageUrl: string;
  matchedDate: string;
}

interface Statistics {
  totalEvents: number;
  totalImages: number;
  firstEventDate: string | null;
  latestEventDate: string | null;
}

// Add interface for props
interface AttendeeDashboardProps {
  setShowSignInModal: (show: boolean) => void;
}

const AttendeeDashboard: React.FC<AttendeeDashboardProps> = ({ setShowSignInModal }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const matchedImagesRef = React.useRef<HTMLDivElement>(null);
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const [attendedEvents, setAttendedEvents] = useState<Event[]>([]);
  const [matchingImages, setMatchingImages] = useState<MatchingImage[]>([]);
  const [filteredImages, setFilteredImages] = useState<MatchingImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [statistics, setStatistics] = useState<Statistics>({
    totalEvents: 0,
    totalImages: 0,
    firstEventDate: null,
    latestEventDate: null
  });
  const [selectedEventFilter, setSelectedEventFilter] = useState<string>('all');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  
  // New state variables for event code entry and selfie upload
  const [eventCode, setEventCode] = useState('');
  const [eventDetails, setEventDetails] = useState<{ id: string; name: string; date: string } | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [selfiePreview, setSelfiePreview] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // New state variables for camera functionality
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [videoRef, setVideoRef] = useState<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [showCameraModal, setShowCameraModal] = useState(false);

  // Add new useEffect to handle URL parameters
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const eventIdFromUrl = searchParams.get('eventId');
    
    if (eventIdFromUrl) {
      setEventCode(eventIdFromUrl);
      // Create an async function to handle the event lookup
      const lookupEvent = async () => {
        try {
          setError(null);
          setEventDetails(null);
          setSuccessMessage(null);
          setProcessingStatus('Looking up event...');
          
          // Get user email if available
          const userEmail = localStorage.getItem('userEmail');
          
          // Try to get event by ID first
          let event = await getEventById(eventIdFromUrl);
          
          if (!event) {
            // Try with leading zeros if needed (for 6-digit codes)
            if (eventIdFromUrl.length < 6) {
              const paddedCode = eventIdFromUrl.padStart(6, '0');
              event = await getEventById(paddedCode);
            }
            
            // If it's exactly 6 digits, try without leading zeros
            if (eventIdFromUrl.length === 6 && eventIdFromUrl.startsWith('0')) {
              const unPaddedCode = eventIdFromUrl.replace(/^0+/, '');
              if (unPaddedCode) {
                event = await getEventById(unPaddedCode);
              }
            }
          }
          
          if (!event) {
            throw new Error(`Event with code "${eventIdFromUrl}" not found. Please check the code and try again.`);
          }
          
          // If user is not signed in, show event details and prompt to sign in
          if (!userEmail) {
            setEventDetails({
              id: event.id,
              name: event.name,
              date: event.date
            });
            setProcessingStatus(null);
            setError('Please sign in to access your photos from this event.');
            return;
          }
          
          // Check if user already has images for this event
          const { getAttendeeImagesByUserAndEvent } = await import('../config/attendeeStorage');
          const existingData = await getAttendeeImagesByUserAndEvent(userEmail, event.id);
          
          if (existingData) {
            // Handle existing data case
            handleExistingEventData(existingData, event);
          } else {
            // Show event details for new upload
            setEventDetails({
              id: event.id,
              name: event.name,
              date: event.date
            });
          }
        } catch (error: any) {
          console.error('Error finding event:', error);
          setError(error.message || 'Failed to find event. Please try again.');
        } finally {
          setProcessingStatus(null);
        }
      };
      
      lookupEvent();
    }
  }, [location.search]); // We don't need handleEventCodeSubmit in dependencies

  // Add the handleExistingEventData helper function
  const handleExistingEventData = (existingData: any, event: any) => {
    setProcessingStatus('Found your previous photos for this event!');
    
    // Add this event to the list if not already there
    const eventExists = attendedEvents.some(e => e.eventId === event.id);
    if (!eventExists) {
      const newEvent: Event = {
        eventId: event.id,
        eventName: event.name,
        eventDate: event.date,
        thumbnailUrl: event.coverImage || existingData.matchedImages[0] || '',
        coverImage: event.coverImage || ''
      };
      setAttendedEvents(prev => [newEvent, ...prev]);
    }
    
    // Add the matched images to the list if not already there
    const newImages: MatchingImage[] = existingData.matchedImages.map((url: string) => ({
      imageId: url.split('/').pop() || '',
      eventId: event.id,
      eventName: event.name,
      imageUrl: url,
      matchedDate: existingData.uploadedAt
    }));
    
    // Check if these images are already in the state
    const existingImageUrls = new Set(matchingImages.map(img => img.imageUrl));
    const uniqueNewImages = newImages.filter(img => !existingImageUrls.has(img.imageUrl));
    
    if (uniqueNewImages.length > 0) {
      setMatchingImages(prev => [...uniqueNewImages, ...prev]);
    }
    
    // Set filter to show only this event's images
    setSelectedEventFilter(event.id);
    
    // Set success message
    setSuccessMessage(`Found ${existingData.matchedImages.length} photos from ${event.name}!`);
  };

  // Scroll to matched images section when success message is set
  useEffect(() => {
    if (successMessage && matchedImagesRef.current) {
      matchedImagesRef.current.scrollIntoView({ behavior: 'smooth' });
      
      // Clear the success message after 5 seconds
      const timer = setTimeout(() => {
        setSuccessMessage(null);
      }, 5000);
      
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        const userEmail = localStorage.getItem('userEmail');
        setLoading(true);

        // Dynamically import required modules
        const { getAllAttendeeImagesByUser, getAttendeeStatistics, getUserDefaultSelfie } = await import('../config/attendeeStorage');
        const { getEventById } = await import('../config/eventStorage');
            
        // If user is signed in, fetch their data
        if (userEmail) {
          // Fetch attendee image data from the database
          const attendeeImageData = await getAllAttendeeImagesByUser(userEmail);
          
          // Get statistics
          const userStats = await getAttendeeStatistics(userEmail);
          setStatistics(userStats);
          
          if (attendeeImageData.length > 0) {
            // Extract events from the attendee image data
            const eventsList: Event[] = [];
            const imagesList: MatchingImage[] = [];
            
            // Process each attendee-event entry sequentially to get event details
            for (const data of attendeeImageData) {
              // Skip the 'default' event entry which is just for storing the default selfie
              if (data.eventId === 'default') continue;
              
              // Get event details from the events database
              const eventDetails = await getEventById(data.eventId);
              
              // Default event name and date if details not found
              const eventName = eventDetails?.name || `Event ${data.eventId}`;
              const eventDate = eventDetails?.date || data.uploadedAt;
              
              // Add to events list if not already added
              if (!eventsList.some(e => e.eventId === data.eventId)) {
                eventsList.push({
                  eventId: data.eventId,
                  eventName: eventName,
                  eventDate: eventDate,
                  // Use event's coverImage if available, otherwise fall back to first matched image
                  thumbnailUrl: eventDetails?.coverImage || data.matchedImages[0] || '',
                  coverImage: eventDetails?.coverImage || ''
                });
              }
              
              // Add all matched images to the images list
              data.matchedImages.forEach(imageUrl => {
                imagesList.push({
                  imageId: imageUrl.split('/').pop() || '',
                  eventId: data.eventId,
                  eventName: eventName,
                  imageUrl: imageUrl,
                  matchedDate: data.uploadedAt
                });
              });
            }
            
            // Update state
            setAttendedEvents(eventsList);
            setMatchingImages(imagesList);
            setFilteredImages(imagesList); // Initially show all images
            
            // Set selfie URL to the most recent selfie
            if (attendeeImageData.length > 0) {
              const defaultEntry = attendeeImageData.find(data => data.eventId === 'default');
              if (defaultEntry) {
                // Use the default selfie if available
                setSelfieUrl(defaultEntry.selfieURL);
              } else {
                // Otherwise use the most recent event selfie
                const mostRecent = attendeeImageData
                  .filter(data => data.eventId !== 'default')
                  .reduce((prev, current) => 
                    new Date(current.uploadedAt) > new Date(prev.uploadedAt) ? current : prev
                  );
                setSelfieUrl(mostRecent.selfieURL);
              }
            }
          } else {
            // Check for default selfie
            const defaultSelfie = await getUserDefaultSelfie(userEmail);
            if (defaultSelfie) {
              setSelfieUrl(defaultSelfie);
            }
          }
        } else {
          // User is not signed in, show empty state with event code entry
          setAttendedEvents([]);
          setMatchingImages([]);
          setFilteredImages([]);
          setStatistics({
            totalEvents: 0,
            totalImages: 0,
            firstEventDate: null,
            latestEventDate: null
          });
          
          // Check if there's a pending action after sign in
          const pendingAction = localStorage.getItem('pendingAction');
          if (pendingAction === 'getPhotos') {
            // Show sign in modal
            setShowSignInModal(true);
          }
        }
        
        setLoading(false);
      } catch (error) {
        console.error('Error fetching user data:', error);
        setLoading(false);
      }
    };

    fetchUserData();
  }, [navigate, location, setShowSignInModal]); // Added location and setShowSignInModal as dependencies

  // Filter images by event
  useEffect(() => {
    if (selectedEventFilter === 'all') {
      setFilteredImages(matchingImages);
    } else {
      const filtered = matchingImages.filter(image => image.eventId === selectedEventFilter);
      setFilteredImages(filtered);
    }
  }, [selectedEventFilter, matchingImages]);

  // Handle event filter change
  const handleEventFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedEventFilter(e.target.value);
  };

  // Handle event code form submission
  const handleEventCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEventDetails(null);
    setSuccessMessage(null);
    
    if (!eventCode.trim()) {
      setError('Please enter an event code');
      return;
    }
    
    try {
      setProcessingStatus('Looking up event...');
      console.log('Looking up event with code:', eventCode);
      
      // Get user email if available
      const userEmail = localStorage.getItem('userEmail');
      
      // Try to get event by ID first
      let event = await getEventById(eventCode);
      console.log('Event lookup result:', event);
      
      // If not found, try some alternative approaches
      if (!event) {
        console.log('Event not found with exact ID, trying alternative methods...');
        
        // Try with leading zeros if needed (for 6-digit codes)
        if (eventCode.length < 6) {
          const paddedCode = eventCode.padStart(6, '0');
          console.log('Trying with padded code:', paddedCode);
          event = await getEventById(paddedCode);
        }
        
        // If it's exactly 6 digits, try without leading zeros
        if (eventCode.length === 6 && eventCode.startsWith('0')) {
          const unPaddedCode = eventCode.replace(/^0+/, '');
          if (unPaddedCode) {
            console.log('Trying without leading zeros:', unPaddedCode);
            event = await getEventById(unPaddedCode);
          }
        }
      }
      
      if (!event) {
        throw new Error(`Event with code "${eventCode}" not found. Please check the code and try again. The code should be the unique identifier provided by the event organizer.`);
      }
      
      console.log('Event found:', event);
      
      // If user is not signed in, show event details and prompt to sign in
      if (!userEmail) {
        setEventDetails({
          id: event.id,
          name: event.name,
          date: event.date
        });
        setProcessingStatus(null);
        setError('Please sign in to access your photos from this event.');
        // Store pendingAction for after sign in
        localStorage.setItem('pendingAction', 'getPhotos');
        // Show sign in modal
        setShowSignInModal(true);
        return;
      }
      
      // Check if user already has images for this event
      const { getAttendeeImagesByUserAndEvent, getUserDefaultSelfie } = await import('../config/attendeeStorage');
      const existingData = await getAttendeeImagesByUserAndEvent(userEmail, event.id);
      
      if (existingData) {
        console.log('User already has images for this event:', existingData);
        setProcessingStatus('Found your previous photos for this event!');
        
        // Add this event to the list if not already there
        const eventExists = attendedEvents.some(e => e.eventId === event.id);
        if (!eventExists) {
          const newEvent: Event = {
            eventId: event.id,
            eventName: event.name,
            eventDate: event.date,
            // Use event's coverImage if available, otherwise fall back to first matched image
            thumbnailUrl: event.coverImage || existingData.matchedImages[0] || '',
            coverImage: event.coverImage || ''
          };
          setAttendedEvents(prev => [newEvent, ...prev]);
        }
        
        // Add the matched images to the list if not already there
        const newImages: MatchingImage[] = existingData.matchedImages.map(url => ({
          imageId: url.split('/').pop() || '',
          eventId: event.id,
          eventName: event.name,
          imageUrl: url,
          matchedDate: existingData.uploadedAt
        }));
        
        // Check if these images are already in the state
        const existingImageUrls = new Set(matchingImages.map(img => img.imageUrl));
        const uniqueNewImages = newImages.filter(img => !existingImageUrls.has(img.imageUrl));
        
        if (uniqueNewImages.length > 0) {
          setMatchingImages(prev => [...uniqueNewImages, ...prev]);
        }
        
        // Set filter to show only this event's images
        setSelectedEventFilter(event.id);
        
        // Clear event code
        setEventCode('');
        
        // Set success message
        setSuccessMessage(`Found ${existingData.matchedImages.length} photos from ${event.name}!`);
        
        // Hide processing status after a delay
        setTimeout(() => setProcessingStatus(null), 1000);
      } else {
        // Check if user has a default selfie or any existing selfie
        const defaultSelfie = await getUserDefaultSelfie(userEmail);
        const existingSelfie = selfieUrl || defaultSelfie;
        
        if (existingSelfie) {
          // User has an existing selfie, use it for comparison automatically
          setProcessingStatus('Using your existing selfie to find photos...');
          
          // Start the face comparison process using the existing selfie
          await performFaceComparisonWithExistingSelfie(userEmail, existingSelfie, event);
          
          // Clear event code
          setEventCode('');
        } else {
          // No existing data or selfie, show the event details and selfie upload form
          setEventDetails({
            id: event.id,
            name: event.name,
            date: event.date
          });
          setProcessingStatus(null);
        }
      }
    } catch (error: any) {
      console.error('Error finding event:', error);
      setError(error.message || 'Failed to find event. Please try again.');
      setProcessingStatus(null);
    }
  };

  // New function to perform face comparison with existing selfie
  const performFaceComparisonWithExistingSelfie = async (userEmail: string, existingSelfieUrl: string, event: any) => {
    try {
      setIsUploading(true);
      setProcessingStatus('Comparing with event images...');
      
      // Extract the S3 key from the selfie URL
      const s3BucketUrl = `https://${S3_BUCKET_NAME}.s3.amazonaws.com/`;
      let selfiePath = '';
      
      if (existingSelfieUrl.startsWith(s3BucketUrl)) {
        selfiePath = existingSelfieUrl.substring(s3BucketUrl.length);
      } else {
        throw new Error('Could not determine S3 path for the existing selfie');
      }
      
      // Get the list of images in the event
      const imagesPath = `events/shared/${event.id}/images/`;
      const listCommand = new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        Prefix: imagesPath,
        MaxKeys: 1000
      });
      
      const listResponse = await s3Client.send(listCommand);
      
      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        throw new Error('No images found in this event.');
      }
      
      const imageKeys = listResponse.Contents
        .filter(item => item.Key && /\.(jpg|jpeg|png)$/i.test(item.Key!))
        .map(item => item.Key!);
      
      if (imageKeys.length === 0) {
        throw new Error('No valid images found in this event.');
      }
      
      // Compare faces in batches
      const batchSize = 10;
      const results: { url: string; similarity: number }[] = [];
      
      for (let i = 0; i < imageKeys.length; i += batchSize) {
        const batch = imageKeys.slice(i, i + batchSize);
        setProcessingStatus(`Comparing with images... ${Math.min(i + batch.length, imageKeys.length)}/${imageKeys.length}`);
        
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
            
            const compareResponse = await rekognitionClient.send(compareCommand);
            
            if (compareResponse.FaceMatches && compareResponse.FaceMatches.length > 0) {
              const bestMatch = compareResponse.FaceMatches.reduce(
                (prev, current) => (prev.Similarity || 0) > (current.Similarity || 0) ? prev : current
              );
              
              return { 
                url: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${key}`, 
                similarity: bestMatch.Similarity || 0 
              };
            }
            return null;
          } catch (error) {
            console.error(`Error processing image ${key}:`, error);
            return null;
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter((result): result is { url: string; similarity: number } => 
          result !== null && result.similarity >= 70
        ));
        
        // Add a small delay between batches
        if (i + batchSize < imageKeys.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Sort matches by similarity
      const sortedMatches = results.sort((a, b) => b.similarity - a.similarity);
      
      if (sortedMatches.length === 0) {
        throw new Error('No matching faces found in the event images.');
      }
      
      // Add matched images to the state
      const newMatchingImages: MatchingImage[] = sortedMatches.map(match => ({
        imageId: match.url.split('/').pop() || '',
        eventId: event.id,
        eventName: event.name,
        imageUrl: match.url,
        matchedDate: new Date().toISOString()
      }));
      
      setMatchingImages(prev => [...newMatchingImages, ...prev]);
      
      // Add this event to attended events if not already there
      const eventExists = attendedEvents.some(e => e.eventId === event.id);
      
      if (!eventExists) {
        const newEvent: Event = {
          eventId: event.id,
          eventName: event.name,
          eventDate: event.date,
          // Use event's coverImage if available, otherwise fall back to first matched image
          thumbnailUrl: event.coverImage || sortedMatches[0].url,
          coverImage: event.coverImage || ''
        };
        
        setAttendedEvents(prev => [newEvent, ...prev]);
      }
      
      // Store the attendee image data in the database
      const matchedImageUrls = sortedMatches.map(match => match.url);
      const currentTimestamp = new Date().toISOString();
      
      // Prepare the data to be stored
      const attendeeData = {
        userId: userEmail,
        eventId: event.id,
        selfieURL: existingSelfieUrl,
        matchedImages: matchedImageUrls,
        uploadedAt: currentTimestamp,
        lastUpdated: currentTimestamp
      };
      
      // Store in the database
      const storageResult = await storeAttendeeImageData(attendeeData);
      
      if (!storageResult) {
        console.error('Failed to store attendee image data in the database');
      }
      
      // Set success message and filter to show only this event's images
      setSuccessMessage(`Found ${sortedMatches.length} new photos from ${event.name}!`);
      setSelectedEventFilter(event.id);
      
      setProcessingStatus(null);
      
    } catch (error: any) {
      console.error('Error in comparison with existing selfie:', error);
      setError(error.message || 'Error processing your request. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  // New function to start the camera
  const startCamera = async () => {
    try {
      // First check if we have the permissions
      if (navigator.permissions && navigator.permissions.query) {
        const result = await navigator.permissions.query({ name: 'camera' as PermissionName });
        if (result.state === 'denied') {
          throw new Error('Camera permission was denied. Please enable camera access in your device settings.');
        }
      }

      // Try to get the video stream with mobile-friendly constraints
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 }
        },
        audio: false
      });
      
      setStream(videoStream);
      setIsCameraActive(true);
      setError(null);
      
      // Wait for the next render cycle to ensure video element exists
      setTimeout(() => {
        const videoElement = document.querySelector('video');
        if (videoElement) {
          videoElement.srcObject = videoStream;
          videoElement.setAttribute('playsinline', 'true'); // Important for iOS
          videoElement.play().catch(console.error);
          setVideoRef(videoElement);
        }
      }, 100);
      
    } catch (error: any) {
      console.error('Error accessing camera:', error);
      let errorMessage = 'Could not access camera. ';
      
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        errorMessage += 'Please grant camera permissions in your device settings.';
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        errorMessage += 'No camera device was found on your device.';
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        errorMessage += 'Your camera may be in use by another application.';
      } else {
        errorMessage += error.message || 'Please check your camera permissions and try again.';
      }
      
      setError(errorMessage);
      setIsCameraActive(false);
    }
  };

  // New function to stop the camera
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

  // New function to capture image from camera
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
      setSelfiePreview(URL.createObjectURL(cameraFile));
      
      // Stop camera and cleanup
      stopCamera();
      
      // Upload the captured selfie
      await uploadSelfie(cameraFile);
      
      // Close the modal
      setShowCameraModal(false);
      
    } catch (error: any) {
      console.error('Error capturing image:', error);
      setError(error.message || 'Failed to capture image. Please try again.');
      // Ensure camera is stopped even if capture fails
      stopCamera();
    }
  };

  // New function to upload the selfie
  const uploadSelfie = async (file: File) => {
    setError(null);
    setSuccessMessage(null);
    setProcessingStatus('Updating your selfie...');
    
    try {
      const userEmail = localStorage.getItem('userEmail') || '';
      
      // Generate a unique filename
      const fileName = `selfie-${Date.now()}-${file.name}`;
      const selfiePath = `users/${userEmail}/selfies/${fileName}`;
      
      // Convert File to arrayBuffer and then to Uint8Array
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      
      // Upload selfie to S3
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: S3_BUCKET_NAME,
          Key: selfiePath,
          Body: uint8Array,
          ContentType: file.type,
          ACL: 'public-read'
        },
        partSize: 1024 * 1024 * 5
      });
      
      await upload.done();
      
      // Get the public URL of the uploaded selfie
      const selfieUrl = `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${selfiePath}`;
      
      // Import the necessary functions
      const { updateUserSelfieURL, getAllAttendeeImagesByUser, storeUserDefaultSelfie } = await import('../config/attendeeStorage');
      
      // Check if the user has any events
      const userEvents = await getAllAttendeeImagesByUser(userEmail);
      
      // If the user has events, update the selfie URL for all of them
      if (userEvents.length > 0) {
        const updateResult = await updateUserSelfieURL(userEmail, selfieUrl);
        
        if (!updateResult) {
          console.warn('Failed to update selfie for existing events');
        }
      }
      
      // Always store a default selfie for future events
      const defaultSelfieResult = await storeUserDefaultSelfie(userEmail, selfieUrl);
      
      if (!defaultSelfieResult) {
        console.warn('Failed to store default selfie');
      }
      
      // Update the selfie URL in state
      setSelfieUrl(selfieUrl);
      
      // Show success message
      setProcessingStatus(null);
      setSuccessMessage('Your selfie has been updated successfully!');
      
      // Scroll to top to show the updated selfie
      window.scrollTo({ top: 0, behavior: 'smooth' });
      
    } catch (error: any) {
      console.error('Error updating selfie:', error);
      setError(error.message || 'Error updating your selfie. Please try again.');
      setProcessingStatus(null);
    }
  };

  // Update user's selfie using camera
  const handleUpdateSelfie = () => {
    // Clear any previous errors
    setError(null);
    setSuccessMessage(null);
    
    // Show camera modal and start the camera
    setShowCameraModal(true);
    startCamera();
  };

  // Clean up camera when component unmounts
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

  // Modify the handleSelfieChange to use handleUpdateSelfie instead
  const handleSelfieChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Instead of handling the file directly, trigger the update selfie flow
    handleUpdateSelfie();
  };

  // Clear selfie selection
  const clearSelfie = () => {
    setSelfie(null);
    if (selfiePreview) {
      URL.revokeObjectURL(selfiePreview);
    }
    setSelfiePreview(null);
  };

  // Upload selfie and compare faces
  const handleUploadAndCompare = async () => {
    // Check for user authentication first
    const userEmail = localStorage.getItem('userEmail');
    if (!userEmail) {
      setError('Please sign in to access your photos from this event.');
      // Store pendingAction for after sign in
      localStorage.setItem('pendingAction', 'getPhotos');
      // Show sign in modal
      setShowSignInModal(true);
      return;
    }

    if (!selfie || !eventDetails) {
      setError('Please select a selfie and enter a valid event code');
      return;
    }
    
    setIsUploading(true);
    setError(null);
    setSuccessMessage(null);
    setProcessingStatus('Uploading selfie...');
    
    try {
      // Fetch complete event details from database
      const completeEventDetails = await getEventById(eventDetails.id);
      
      if (!completeEventDetails) {
        throw new Error('Could not retrieve complete event details from database.');
      }
      
      // Generate a unique filename
      const fileName = `selfie-${Date.now()}-${selfie.name}`;
      const selfiePath = `events/shared/${eventDetails.id}/selfies/${fileName}`;
      
      // Convert File to arrayBuffer and then to Uint8Array
      const buffer = await selfie.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      
      // Upload selfie to S3
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: S3_BUCKET_NAME,
          Key: selfiePath,
          Body: uint8Array,
          ContentType: selfie.type,
          ACL: 'public-read'
        },
        partSize: 1024 * 1024 * 5
      });
      
      await upload.done();
      
      // After successful upload, start face comparison
      setProcessingStatus('Comparing with event images...');
      
      // Get the list of images in the event
      const imagesPath = `events/shared/${eventDetails.id}/images/`;
      const listCommand = new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        Prefix: imagesPath,
        MaxKeys: 1000
      });
      
      const listResponse = await s3Client.send(listCommand);
      
      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        throw new Error('No images found in this event.');
      }
      
      // Get the uploaded selfie URL
      const selfieUrl = `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${selfiePath}`;
      
      // Compare faces with each image
      const matchingImages: MatchingImage[] = [];
      for (const image of listResponse.Contents) {
        if (!image.Key) continue;
        
        const imageUrl = `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${image.Key}`;
        
        try {
          const result = await compareFaces(selfieUrl, imageUrl);
          if (result) {
            matchingImages.push({
              imageId: image.Key.split('/').pop() || '',
              eventId: eventDetails.id,
              eventName: eventDetails.name,
              imageUrl,
              matchedDate: new Date().toISOString()
            });
          }
        } catch (error) {
          console.error('Error comparing faces:', error);
          continue;
        }
      }
      
      if (matchingImages.length > 0) {
        // Store the matching images for the user
        const { storeAttendeeImageData } = await import('../config/attendeeStorage');
        await storeAttendeeImageData({
          userId: userEmail,
          eventId: eventDetails.id,
          selfieURL: selfieUrl,
          matchedImages: matchingImages.map(img => img.imageUrl),
          uploadedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        });
        
        // Update the UI
        setMatchingImages(matchingImages);
        setFilteredImages(matchingImages);
        setSuccessMessage(`Found ${matchingImages.length} matching photos!`);
      } else {
        setError('No matching photos found. Please try again with a different selfie.');
      }
    } catch (error) {
      console.error('Error in upload and compare:', error);
      setError(error instanceof Error ? error.message : 'An error occurred while processing your request.');
    } finally {
      setIsUploading(false);
      setProcessingStatus(null);
    }
  };

  // Handle event click to view associated images
  const handleEventClick = (eventId: string) => {
    // Navigate to the event photos page
    navigate(`/event-photos/${eventId}`);
  };

  const handleDownload = async (url: string) => {
    try {
      const userEmail = localStorage.getItem('userEmail') || '';
      const response = await fetch(url, {
        headers: {
          'Cache-Control': 'no-cache',
        },
        mode: 'cors',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      
      // Get the content type
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      
      // Get the image as a blob
      const blob = await response.blob();
      
      // Create a blob URL
      const blobUrl = window.URL.createObjectURL(blob);
      
      // Extract filename from URL
      const filename = url.split('/').pop() || 'photo.jpg';
      
      // Create a temporary anchor element
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.type = contentType;
      link.target = '_blank';
      
      // Required for Firefox
      document.body.appendChild(link);
      
      // Trigger the download
      link.click();
      
      // Cleanup
      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(blobUrl);
      }, 100);
    } catch (error) {
      console.error('Error downloading image:', error);
      // If download fails, open the image in a new tab
      window.open(url, '_blank');
    }
  };

  const handleDownloadAll = async () => {
    try {
      // Show a message that downloads are starting
      alert('Starting downloads. Please allow multiple downloads in your browser settings.');
      
      // Download each image with a small delay to prevent browser blocking
      for (const image of filteredImages) {
        await handleDownload(image.imageUrl);
        // Add a small delay between downloads
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error('Error downloading all images:', error);
      alert('Some downloads may have failed. Please try downloading individual photos.');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading your dashboard...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pt-20 pb-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Your Event Memories</h1>
          <p className="mt-2 text-black-600">Find and view your photos from events</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Main Actions Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Event Code Entry Section */}
            <div className="bg-white rounded-lg shadow-sm p-4">
              <h2 className="text-lg font-semibold text-gray-900 mb-3">Enter Event Code</h2>
              <p className="text-sm text-gray-600 mb-3">
                Find your photos from events
              </p>
              
              {error && (
                <div className="bg-red-50 text-red-600 p-2 rounded-lg mb-3 text-sm">
                  {error}
                </div>
              )}
              
              {processingStatus && (
                <div className="bg-blue-50 text-blue-600 p-2 rounded-lg mb-3 text-sm flex items-center">
                  <div className="animate-spin rounded-full h-3 w-3 border-t-2 border-b-2 border-blue-600 mr-2"></div>
                  {processingStatus}
                </div>
              )}
              
              <form onSubmit={handleEventCodeSubmit} className="mb-3">
                <div className="flex space-x-2">
                  <input
                    type="text"
                    value={eventCode}
                    onChange={(e) => setEventCode(e.target.value)}
                    placeholder="Event code"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    required
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center text-sm"
                    disabled={isUploading}
                  >
                    <Search className="w-4 h-4 mr-1" />
                    Find
                  </button>
                </div>
              </form>
              
              {eventDetails && (
                <div className="border border-blue-200 bg-blue-50 p-3 rounded-lg mb-3">
                  <h3 className="font-semibold text-blue-800 text-sm">{eventDetails.name}</h3>
                  <p className="text-blue-600 text-xs">
                    {new Date(eventDetails.date).toLocaleDateString()}
                  </p>
                  
                  <div className="mt-3">
                    <p className="text-gray-700 text-sm mb-2">
                      Upload a selfie to find your photos
                    </p>
                    {selfiePreview ? (
                      <div className="relative w-20 h-20 mb-2">
                        <img
                          src={selfiePreview}
                          alt="Selfie preview"
                          className="w-full h-full object-cover rounded-lg"
                        />
                        <button
                          onClick={clearSelfie}
                          className="absolute -top-1 -right-1 bg-blue-500 text-white rounded-full p-1 hover:bg-blue-600 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={handleUpdateSelfie}
                        className="cursor-pointer bg-blue-100 text-blue-800 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition-colors inline-block text-sm"
                      >
                        <Camera className="w-3 h-3 inline-block mr-1" />
                        Select Selfie
                      </button>
                    )}
                    
                    <button
                      onClick={handleUploadAndCompare}
                      disabled={isUploading || !selfie}
                      className={`w-full px-3 py-1.5 rounded-lg text-sm ${
                        isUploading || !selfie
                          ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      } transition-colors flex items-center justify-center`}
                    >
                      {isUploading ? (
                        <>
                          <div className="animate-spin rounded-full h-3 w-3 border-t-2 border-b-2 border-white mr-1"></div>
                          Processing...
                        </>
                      ) : (
                        <>
                          <Camera className="w-3 h-3 mr-1" />
                          Find Photos
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Attended Events Section */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Your Event Albums</h2>
              {attendedEvents.length === 0 ? (
                <div className="bg-gray-50 rounded-lg p-6 text-center">
                  <Calendar className="h-12 w-12 text-gray-400 mx-auto mb-2" />
                  <p className="text-gray-600">You haven't attended any events yet.</p>
                  <p className="text-gray-500 text-sm mt-2">Enter an event code above to find your photos from an event.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {attendedEvents.map((event) => (
                    <div
                      key={event.eventId}
                      className="group bg-white rounded-lg border border-gray-200 overflow-hidden hover:shadow-lg transition-all duration-300 cursor-pointer transform hover:-translate-y-1"
                      onClick={() => handleEventClick(event.eventId)}
                    >
                      {/* Cover Image Container with Fixed Height */}
                      <div className="relative h-48 w-full overflow-hidden">
                        <img
                          src={event.coverImage || event.thumbnailUrl}
                          alt={event.eventName}
                          className="absolute inset-0 w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-300"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                      </div>

                      {/* Event Details Container */}
                      <div className="p-4">
                        <h3 className="text-base font-semibold text-gray-900 mb-1 line-clamp-2">
                          {event.eventName}
                        </h3>
                        <div className="flex flex-col space-y-2">
                          <p className="text-sm text-gray-600 flex items-center">
                            <Calendar className="w-4 h-4 mr-1.5" />
                            {new Date(event.eventDate).toLocaleDateString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric'
                            })}
                          </p>
                          
                          {/* View Photos Button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEventClick(event.eventId);
                            }}
                            className="w-full mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center group-hover:bg-blue-700"
                          >
                            <ImageIcon className="w-4 h-4 mr-2" />
                            <span className="text-sm font-medium">View Photos</span>
                            <ArrowRight className="w-4 h-4 ml-2 transform group-hover:translate-x-1 transition-transform" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Sidebar Column */}
          <div className="space-y-6">
            {/* Selfie Section */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Your Selfie</h2>
              <div className="flex flex-col items-center">
                <div className="h-32 w-32 rounded-full overflow-hidden bg-gray-100 relative mb-4">
                  {selfieUrl ? (
                    <img src={selfieUrl} alt="Your selfie" className="h-full w-full object-cover" />
                  ) : (
                    <Camera className="h-full w-full text-gray-400 p-8" />
                  )}
                  {processingStatus && processingStatus.includes('Updating your selfie') && (
                    <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white"></div>
                    </div>
                  )}
                </div>
                <p className="text-gray-600 text-center mb-4">Used for photo matching across all events</p>
                {successMessage && successMessage.includes('selfie') && (
                  <p className="text-green-600 text-sm text-center mb-4">✓ Selfie updated successfully</p>
                )}
                <button
                  onClick={handleUpdateSelfie}
                  disabled={!!processingStatus && processingStatus.includes('Updating your selfie')}
                  className={`w-full px-4 py-2 rounded-lg ${
                    processingStatus && processingStatus.includes('Updating your selfie')
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  } transition-colors flex items-center justify-center`}
                >
                  {processingStatus && processingStatus.includes('Updating your selfie') ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                      Updating...
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4 mr-2" />
                      Update Selfie
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Quick Stats Section */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Your Photo Stats</h2>
              <div className="space-y-3">
                <div className="bg-blue-50 rounded-lg p-3 flex justify-between items-center">
                  <span className="text-gray-700">Events</span>
                  <span className="text-lg font-bold text-blue-600">{statistics.totalEvents - 1}</span>
                </div>
                <div className="bg-blue-50 rounded-lg p-3 flex justify-between items-center">
                  <span className="text-gray-700">Photos</span>
                  <span className="text-lg font-bold text-blue-600">{statistics.totalImages}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Matching Images Section */}
        <div ref={matchedImagesRef} className="bg-white rounded-lg shadow-sm p-6 mb-8">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">
                {selectedEventFilter !== 'all' 
                  ? `Photos from ${attendedEvents.find(e => e.eventId === selectedEventFilter)?.eventName || 'Event'}`
                  : 'All Your Photos'
                }
              </h2>
              {selectedEventFilter !== 'all' && (
                <p className="text-gray-600 text-sm mt-1">
                  {attendedEvents.find(e => e.eventId === selectedEventFilter)?.eventDate 
                    ? `Event date: ${new Date(attendedEvents.find(e => e.eventId === selectedEventFilter)?.eventDate || '').toLocaleDateString()}`
                    : ''
                  }
                </p>
              )}
            </div>
            <div className="flex items-center gap-4">
              {filteredImages.length > 0 && (
                <button
                  onClick={handleDownloadAll}
                  className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download All
                </button>
              )}
              <label htmlFor="event-filter" className="text-gray-700">Filter by event:</label>
              <select
                id="event-filter"
                value={selectedEventFilter}
                onChange={handleEventFilterChange}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Events</option>
                {attendedEvents.map(event => (
                  <option key={event.eventId} value={event.eventId}>
                    {event.eventName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          
          {successMessage && (
            <div className="bg-green-50 text-green-700 p-4 rounded-lg mb-6 flex items-center animate-pulse">
              <div className="bg-green-100 rounded-full p-2 mr-3">
                <span className="text-green-500">✓</span>
              </div>
              {successMessage}
            </div>
          )}
          
          {filteredImages.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredImages.map((image) => (
                <div
                  key={image.imageId}
                  className="bg-white rounded-lg shadow-sm overflow-hidden hover:shadow-md transition-shadow border border-gray-200"
                >
                  <div className="aspect-square relative">
                    <img
                      src={image.imageUrl}
                      alt={`Matched photo from ${image.eventName}`}
                      className="object-cover w-full h-full"
                    />
                    <button
                      onClick={() => handleDownload(image.imageUrl)}
                      className="absolute top-2 right-2 p-2 bg-black/50 text-white rounded-full hover:bg-black/70 transition-colors"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-10">
              <ImageIcon className="h-12 w-12 text-gray-400 mx-auto" />
              {selectedEventFilter !== 'all' ? (
                <>
                  <p className="mt-2 text-gray-500">No photos found for this event</p>
                  <button
                    onClick={() => setSelectedEventFilter('all')}
                    className="mt-4 text-blue-600 hover:text-blue-800 px-4 py-2 border border-blue-300 rounded-lg"
                  >
                    Show all photos
                  </button>
                </>
              ) : (
                <>
                  <p className="mt-2 text-gray-500">No matching photos found for any events</p>
                  <p className="mt-2 text-sm text-gray-500">Enter an event code above to find your photos</p>
                </>
              )}
            </div>
          )}
          
          {filteredImages.length > 0 && selectedEventFilter !== 'all' && (
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setSelectedEventFilter('all')}
                className="text-blue-600 hover:text-blue-800 flex items-center"
              >
                Show all photos <ArrowRight className="ml-1 h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>
      
      {/* Camera Modal */}
      {showCameraModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full relative">
            <button
              onClick={() => {
                stopCamera();
                setShowCameraModal(false);
              }}
              className="absolute -top-3 -right-3 bg-white text-gray-700 rounded-full p-2 shadow-lg hover:bg-gray-100"
            >
              <X className="w-5 h-5" />
            </button>
            
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Take a Selfie</h3>
            
            {error && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg">
                {error}
              </div>
            )}
            
            <div className="relative w-full">
              {isCameraActive && (
                <div className="mb-4">
                  <video
                    autoPlay
                    playsInline
                    className="w-full rounded-lg border-2 border-blue-500"
                    style={{ transform: 'scaleX(-1)' }} // Mirror the video feed
                  />
                  
                  <button
                    onClick={captureImage}
                    className="mt-4 w-full py-2 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center"
                  >
                    <Camera className="w-5 h-5 mr-2" />
                    Capture Selfie
                  </button>
                </div>
              )}
              
              {!isCameraActive && processingStatus && (
                <div className="flex items-center justify-center p-6">
                  <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600 mr-3"></div>
                  <p className="text-blue-600">{processingStatus}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AttendeeDashboard; 