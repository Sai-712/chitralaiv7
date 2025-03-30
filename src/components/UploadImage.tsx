import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Upload } from '@aws-sdk/lib-storage';
import { S3_BUCKET_NAME, s3Client } from '../config/aws';
import { Upload as UploadIcon, X, Download, ArrowLeft, Copy, Loader2, Camera } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getUserEvents } from '../config/eventStorage';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const BATCH_SIZE = 20; // Number of images to process in each batch
const IMAGES_PER_PAGE = 50; // Number of images to show per page

const UploadImage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const [images, setImages] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [eventId, setEventId] = useState<string>('');
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [events, setEvents] = useState<{ id: string; name: string }[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [showQRModal, setShowQRModal] = useState(false);
  const [showCopySuccess, setShowCopySuccess] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [imagePreviews, setImagePreviews] = useState<{ [key: string]: string }>({});

  // Handle scroll for pagination
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      setCurrentPage(prev => prev + 1);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  useEffect(() => {
    const initializeComponent = async () => {
      const userEmail = localStorage.getItem('userEmail');
      if (!userEmail) return;

      try {
        // Fetch user events
        const userEvents = await getUserEvents(userEmail);
        const eventsList = userEvents.map(event => ({
          id: event.id,
          name: event.name,
        }));
        setEvents(eventsList);

        // Extract eventId from URL params or state or localStorage
        let targetEventId = '';
        
        // Check URL parameters first
        const searchParams = new URLSearchParams(window.location.search);
        const urlEventId = searchParams.get('eventId');
        
        if (urlEventId) {
          console.log('EventId from URL params:', urlEventId);
          targetEventId = urlEventId;
        } 
        // Check location state (from navigation)
        else if (location.state?.eventId) {
          console.log('EventId from location state:', location.state.eventId);
          targetEventId = location.state.eventId;
        }
        // Check localStorage as last resort
        else {
          const storedEventId = localStorage.getItem('currentEventId');
          if (storedEventId) {
            console.log('EventId from localStorage:', storedEventId);
            targetEventId = storedEventId;
          }
        }

        if (targetEventId) {
          // Find the event in the list to confirm it exists
          const eventExists = eventsList.some(event => event.id === targetEventId);
          
          if (eventExists) {
            setEventId(targetEventId);
            setSelectedEvent(targetEventId);
            console.log('Set selected event to:', targetEventId);
          } else {
            console.warn('Event ID from URL/state not found in user events:', targetEventId);
          }
        }
      } catch (error) {
        console.error('Error initializing UploadImage component:', error);
      }
    };

    initializeComponent();
  }, [location]);

  // Find the current event name for display
  const getSelectedEventName = () => {
    const event = events.find(e => e.id === selectedEvent);
    return event ? event.name : 'Select an Event';
  };

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      // Filter out selfie images and validate file size
      const validFiles = files.filter(file => {
        const fileName = file.name.toLowerCase();
        const isValidType = file.type.startsWith('image/');
        const isValidSize = file.size <= MAX_FILE_SIZE;
        const isNotSelfie = !fileName.includes('selfie') && !fileName.includes('self');
        return isValidType && isValidSize && isNotSelfie;
      });

      if (validFiles.length !== files.length) {
        alert('Some files were skipped because they were selfies or exceeded the 50MB size limit.');
      }

      // Process images in batches to prevent memory issues
      const processBatch = async (files: File[]) => {
        const batchPromises = files.map(async (file) => {
          // Create preview URL
          const previewUrl = URL.createObjectURL(file);
          setImagePreviews(prev => ({ ...prev, [file.name]: previewUrl }));
          return file;
        });

        const processedFiles = await Promise.all(batchPromises);
        setImages(prev => [...prev, ...processedFiles]);
      };

      // Process files in batches
      for (let i = 0; i < validFiles.length; i += BATCH_SIZE) {
        const batch = validFiles.slice(i, i + BATCH_SIZE);
        processBatch(batch);
      }
    }
  }, []);

  // Cleanup preview URLs when component unmounts or images are removed
  useEffect(() => {
    return () => {
      Object.values(imagePreviews).forEach(url => URL.revokeObjectURL(url));
    };
  }, [imagePreviews]);

  const removeImage = useCallback((index: number) => {
    setImages(prev => {
      const newImages = prev.filter((_, i) => i !== index);
      // Cleanup preview URL
      const removedFile = prev[index];
      if (removedFile && imagePreviews[removedFile.name]) {
        URL.revokeObjectURL(imagePreviews[removedFile.name]);
        setImagePreviews(prev => {
          const newPreviews = { ...prev };
          delete newPreviews[removedFile.name];
          return newPreviews;
        });
      }
      return newImages;
    });
  }, [imagePreviews]);

  const uploadToS3 = useCallback(
    async (file: File, fileName: string): Promise<string> => {
      if (!selectedEvent) {
        throw new Error('Event ID is required for uploading images.');
      }
      console.log(`Uploading file: ${fileName}`);
      const sessionId = localStorage.getItem('sessionId');
      const folderPath = `events/shared/${selectedEvent}/images/${fileName}`;

      const uploadParams = {
        Bucket: S3_BUCKET_NAME,
        Key: folderPath,
        Body: file,
        ContentType: file.type,
        Metadata: {
          'event-id': selectedEvent,
          'session-id': sessionId || '',
          'upload-date': new Date().toISOString(),
        },
      };

      const uploadInstance = new Upload({
        client: s3Client,
        params: uploadParams,
        partSize: 50 * 1024 * 1024,
        leavePartsOnError: false,
      });

      await uploadInstance.done();
      return folderPath;
    },
    [selectedEvent]
  );

  const handleUpload = useCallback(async () => {
    if (images.length === 0) {
      alert('Please select at least one image to upload.');
      return;
    }
    if (!selectedEvent) {
      alert('Please select or create an event before uploading images.');
      return;
    }

    setIsUploading(true);
    setUploadSuccess(false);
    
    // Add state to track current upload progress
    let uploadedCount = 0;
    const totalCount = images.length;
    setUploadProgress({ current: 0, total: totalCount });

    try {
      const uploadPromises = images.map(async (image, index) => {
        if (!image.type.startsWith('image/')) {
          throw new Error(`${image.name} is not a valid image file`);
        }
        if (image.size > MAX_FILE_SIZE) {
          throw new Error(`${image.name} exceeds the 50MB size limit`);
        }
        const fileName = `${Date.now()}-${image.name}`;
        try {
          const imageUrl = await uploadToS3(image, fileName);
          
          // Update progress after each successful upload
          uploadedCount++;
          setUploadProgress({ current: uploadedCount, total: totalCount });
          
          return `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${imageUrl}`;
        } catch (error) {
          console.error(`Failed to upload ${image.name}:`, error);
          throw new Error(`Failed to upload ${image.name}. Please try again.`);
        }
      });

      const urls = await Promise.all(uploadPromises);
      console.log('Uploaded images:', urls);
      setUploadedUrls(urls);
      localStorage.setItem('currentEventId', selectedEvent);
      setEventId(selectedEvent);
      setUploadSuccess(true);
      setShowQRModal(true);
    } catch (error) {
      console.error('Error uploading images:', error);
      alert(error instanceof Error ? error.message : 'Failed to upload images. Please try again.');
    } finally {
      setIsUploading(false);
      setUploadProgress(null); // Reset progress when done
    }
  }, [images, selectedEvent, uploadToS3]);

  const handleDownload = useCallback(async (url: string) => {
    try {
      const response = await fetch(url, {
        mode: 'cors',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        const errorMessage = `Failed to download image (${response.status}): ${response.statusText}`;
        console.error(errorMessage);
        alert(errorMessage);
        throw new Error(errorMessage);
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('image/')) {
        const errorMessage = 'Invalid image format received';
        console.error(errorMessage);
        alert(errorMessage);
        throw new Error(errorMessage);
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
      console.log(`Successfully downloaded: ${fileName}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred while downloading the image';
      console.error('Error downloading image:', error);
      alert(errorMessage);
      throw error;
    }
  }, []);

  const handleDownloadAll = useCallback(async () => {
    const downloadPromises = uploadedUrls.map(url =>
      handleDownload(url).catch(error => ({ error, url }))
    );
    const results = await Promise.allSettled(downloadPromises);

    let successCount = 0;
    let failedUrls: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failedUrls.push(uploadedUrls[index]);
      }
    });

    if (failedUrls.length === 0) {
      alert(`Successfully downloaded all ${successCount} images!`);
    } else {
      alert(`Downloaded ${successCount} images. Failed to download ${failedUrls.length} images. Please try again later.`);
    }
  }, [uploadedUrls, handleDownload]);

  const handleCopyLink = useCallback(() => {
    const link = `${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`;
    navigator.clipboard.writeText(link);
    setShowCopySuccess(true);
    setTimeout(() => setShowCopySuccess(false), 2000);
  }, [selectedEvent]);

  const handleDownloadQR = useCallback(() => {
    try {
      const canvas = document.createElement('canvas');
      const svg = document.querySelector('.qr-modal svg');
      if (!svg) {
        throw new Error('QR code SVG element not found');
      }
      const svgData = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Could not get canvas context');
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) {
            throw new Error('Could not create image blob');
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `selfie-upload-qr-${selectedEvent}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 'image/png');
      };
      img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
    } catch (error) {
      console.error('Error downloading QR code:', error);
      alert('Failed to download QR code. Please try again.');
    }
  }, [selectedEvent]);

  return (
    <div className="relative bg-grey-100 min-h-screen">
      {/* Add spacer div to push content below navbar */}
      <div className="h-14 sm:h-16 md:h-20"></div>
      
      <div className="container mx-auto px-4 py-2 relative z-10 mt-4">
        <video autoPlay loop muted className="fixed top-0 left-0 w-full h-full object-cover opacity-100 -z-10">
          <source src="tiny.mp4" type="video/mp4" />
          Your browser does not support the video tag.
        </video>
        <div className="relative z-10 container mx-auto px-4 py-4">
          <div className="max-w-2xl mx-auto bg-white p-4 sm:p-8 rounded-lg shadow-md border-4 border-blue-900">
            <div className="flex flex-col items-center justify-center mb-4 sm:mb-6 space-y-4">
              <select
                value={selectedEvent}
                onChange={(e) => {
                  const newEventId = e.target.value;
                  setSelectedEvent(newEventId);
                  setEventId(newEventId);
                  // Store in localStorage for persistence
                  if (newEventId) {
                    localStorage.setItem('currentEventId', newEventId);
                  }
                }}
                className="border border-blue-400 rounded-lg px-4 py-2 w-full max-w-md text-black focus:outline-none focus:border-blue-900 bg-white"
              >
                <option value="">Select an Event</option>
                {events.map(event => (
                  <option key={event.id} value={event.id}>
                    {event.name}
                  </option>
                ))}
              </select>
              <h2 className="text-xl sm:text-2xl font-bold text-black text-center">Upload Images</h2>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-center w-full">
                <label
                  htmlFor="file-upload"
                  className="w-full flex flex-col items-center px-4 py-6 bg-blue-100 rounded-lg border-2 border-turquoise border-dashed cursor-pointer hover:border-blue-300 hover:bg-champagne transition-colors duration-200"
                >
                  <div className="flex flex-col items-center">
                    <img src="/upload-placeholder.svg" alt="Upload" className="w-64 h-48 object-contain" />
                    <p className="text-xs text-blue-500 mt-1">PNG, JPG, GIF up to 50MB</p>
                  </div>
                  <input
                    id="file-upload"
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleImageChange}
                    accept="image/*"
                  />
                </label>
              </div>
              {images.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm text-blue-600 mb-2">{images.length} file(s) selected</p>
                  <div className="flex flex-wrap gap-2 max-h-60 overflow-y-auto p-2">
                    {images.map((image, index) => (
                      <div key={index} className="relative group">
                        <img
                          src={URL.createObjectURL(image)}
                          alt={`Preview ${index + 1}`}
                          className="w-20 h-20 object-cover rounded"
                        />
                        <button
                          onClick={() => removeImage(index)}
                          className="absolute -top-2 -right-2 bg-blue-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {uploadSuccess && uploadedUrls.length > 0 && (
                <div className="mt-6 p-6 bg-blue-50 rounded-xl shadow-lg border-2 border-blue-200">
                  <h3 className="text-xl font-bold mb-4 text-blue-800 flex items-center">
                    <Camera className="w-5 h-5 mr-2" />
                    Uploaded Images
                  </h3>
                  
                  <div 
                    ref={containerRef}
                    className="grid grid-cols-2 sm:grid-cols-3 gap-4 max-h-[400px] overflow-auto p-4 bg-white rounded-xl shadow-inner"
                  >
                    {uploadedUrls.map((url, index) => (
                      <div key={index} className="relative">
                        <div className="rounded-lg overflow-hidden shadow-md">
                          <img
                            src={url}
                            alt={`Uploaded ${index + 1}`}
                            className="w-full aspect-square object-cover"
                          />
                        </div>
                        <button
                          onClick={() => handleDownload(url)}
                          className="absolute bottom-2 right-2 p-2 bg-white rounded-full shadow-md hover:bg-blue-100 transition-colors"
                          title="Download Image"
                        >
                          <Download className="h-4 w-4 text-blue-700" />
                        </button>
                      </div>
                    ))}
                    {currentPage * IMAGES_PER_PAGE < uploadedUrls.length && (
                      <div className="col-span-full text-center py-4">
                        <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
                        <p className="text-sm text-blue-500 mt-2">Loading more images...</p>
                      </div>
                    )}
                  </div>
                  
                  <div className="mt-6 flex justify-between items-center">
                    <div className="text-sm text-blue-700 font-medium">
                      {uploadedUrls.length} {uploadedUrls.length === 1 ? 'image' : 'images'} uploaded successfully
                    </div>
                    {uploadedUrls.length > 1 && (
                      <button
                        onClick={handleDownloadAll}
                        className="flex items-center justify-center py-2.5 px-5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors duration-200 shadow-md"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        Download All
                      </button>
                    )}
                  </div>
                </div>
              )}
              <button
                onClick={handleUpload}
                disabled={isUploading || images.length === 0}
                className={`w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200 ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {isUploading ? (
                  <span className="flex items-center justify-center">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Uploading {uploadProgress?.current}/{uploadProgress?.total}...
                  </span>
                ) : (
                  'Upload Images'
                )}
              </button>
              {isUploading && uploadProgress && (
                <div className="mt-2 w-full bg-gray-200 rounded-full h-2.5">
                  <div 
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" 
                    style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                  ></div>
                </div>
              )}
            </div>
            {showQRModal && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999] p-4 overflow-y-auto">
                <div className="bg-blue-300 rounded-lg p-4 sm:p-6 max-w-sm w-full relative mx-auto mt-20 md:mt-0 mb-20 md:mb-0">
                  <div className="absolute top-2 right-2">
                    <button 
                      onClick={() => setShowQRModal(false)} 
                      className="bg-white rounded-full p-1 text-gray-500 hover:text-gray-700 shadow-md hover:bg-gray-100 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="flex flex-col items-center space-y-4 pt-6">                    
                    <h3 className="text-lg sm:text-xl font-semibold text-center">Share Event</h3>
                    <p className="text-sm text-blue-700 mb-2 text-center px-2">Share this QR code or link with others to let them find their photos</p>
                    <div className="qr-modal relative bg-white p-3 rounded-lg mx-auto flex justify-center">
                      <QRCodeSVG
                        value={`${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`}
                        size={180}
                        level="H"
                        includeMargin={true}
                        bgColor="#FFFFFF"
                        fgColor="#000000"
                      />
                      <button
                        onClick={() => {
                          const canvas = document.createElement('canvas');
                          const qrCode = document.querySelector('.qr-modal svg');
                          if (!qrCode) return;
                          
                          const serializer = new XMLSerializer();
                          const svgStr = serializer.serializeToString(qrCode);
                          
                          const img = new Image();
                          img.src = 'data:image/svg+xml;base64,' + btoa(svgStr);
                          
                          img.onload = () => {
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');
                            if (!ctx) return;
                            
                            ctx.fillStyle = '#FFFFFF';
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(img, 0, 0);
                            
                            canvas.toBlob((blob) => {
                              if (!blob) return;
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `qr-code-${selectedEvent}.png`;
                              document.body.appendChild(a);
                              a.click();
                              document.body.removeChild(a);
                              URL.revokeObjectURL(url);
                            }, 'image/png');
                          };
                        }}
                        className="absolute top-0 right-0 -mt-2 -mr-2 p-1 bg-white rounded-full shadow-md hover:bg-gray-50 transition-colors"
                        title="Download QR Code"
                      >
                        <Download className="w-4 h-4 text-gray-600" />
                      </button>
                    </div>
                    <div className="w-full">
                      <div className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                        <input
                          type="text"
                          readOnly
                          value={`${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`}
                          className="w-full bg-transparent text-sm overflow-hidden text-ellipsis"
                        />
                        <button onClick={handleCopyLink} className="px-3 py-1 bg-turquoise text-blue-300 rounded hover:bg-aquamarine transition-colors flex-shrink-0">
                          Copy
                        </button>
                      </div>
                      {showCopySuccess && <p className="text-sm text-green-600 mt-1 text-center">Link copied to clipboard!</p>}
                    </div>
                    <div className="flex gap-2 w-full">
                      <button
                        onClick={handleDownloadQR}
                        className="flex-1 bg-black text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors duration-200 flex items-center justify-center text-sm"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        Download QR
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`);
                          setShowCopySuccess(true);
                          setTimeout(() => setShowCopySuccess(false), 2000);
                        }}
                        className="flex-1 bg-black text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors duration-200 flex items-center justify-center text-sm"
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        {showCopySuccess ? 'Copied!' : 'Share Link'}
                      </button>
                    </div>
                    <button
                      onClick={() => {
                        setShowQRModal(false);
                        navigate(`/attendee-dashboard?eventId=${selectedEvent}`, { state: { eventId: selectedEvent } });
                      }}
                      className="w-full bg-blue-600 text-black py-2 px-4 rounded-lg hover:bg-blue-200 transition-colors duration-200 flex items-center justify-center"
                    >
                      Continue to Attendee Dashboard
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default UploadImage;