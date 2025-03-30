import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Image as ImageIcon, Download, X } from 'lucide-react';
import { getEventById } from '../config/eventStorage';
import { getAllAttendeeImagesByUser } from '../config/attendeeStorage';

interface Event {
  id: string;
  name: string;
  date: string;
}

interface MatchingImage {
  imageId: string;
  eventId: string;
  eventName: string;
  imageUrl: string;
  matchedDate: string;
}

const EventPhotos: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const [event, setEvent] = useState<Event | null>(null);
  const [images, setImages] = useState<MatchingImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState<MatchingImage | null>(null);

  // Toggle header and footer visibility
  const toggleHeaderFooter = (visible: boolean) => {
    // Find header and footer elements in DOM
    const header = document.querySelector('header');
    const footer = document.querySelector('footer');
    
    if (header) {
      if (visible) {
        header.classList.remove('hidden');
      } else {
        header.classList.add('hidden');
      }
    }
    
    if (footer) {
      if (visible) {
        footer.classList.remove('hidden');
      } else {
        footer.classList.add('hidden');
      }
    }
  };

  useEffect(() => {
    const fetchEventPhotos = async () => {
      try {
        setLoading(true);
        const userEmail = localStorage.getItem('userEmail');
        if (!userEmail) {
          navigate('/GoogleLogin');
          return;
        }

        // Get event details
        const eventDetails = await getEventById(eventId || '');
        if (!eventDetails) {
          console.error('Event not found');
          navigate('/attendee-dashboard');
          return;
        }
        setEvent(eventDetails);

        // Get all attendee images
        const attendeeImageData = await getAllAttendeeImagesByUser(userEmail);
        
        // Filter images for this event
        const eventImages = attendeeImageData
          .filter(data => data.eventId === eventId)
          .flatMap(data => 
            data.matchedImages.map(url => ({
              imageId: url.split('/').pop() || '',
              eventId: data.eventId,
              eventName: eventDetails.name,
              imageUrl: url,
              matchedDate: data.uploadedAt
            }))
          );

        setImages(eventImages);
      } catch (error) {
        console.error('Error fetching event photos:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchEventPhotos();
  }, [eventId, navigate]);

  const handleDownload = async (url: string) => {
    try {
      // Fetch the image with appropriate headers
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
      for (const image of images) {
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
            <p className="mt-4 text-gray-600">Loading photos...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pt-20 pb-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <button
            onClick={() => navigate('/attendee-dashboard')}
            className="text-blue-600 hover:text-blue-800 flex items-center mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Dashboard
          </button>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">{event?.name}</h1>
              <p className="mt-2 text-gray-600">
                {event?.date ? new Date(event.date).toLocaleDateString() : 'Date not available'}
              </p>
            </div>
            {images.length > 0 && (
              <button
                onClick={handleDownloadAll}
                className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Download className="h-4 w-4 mr-2" />
                Download All
              </button>
            )}
          </div>
        </div>

        {images.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {images.map((image) => (
              <div
                key={image.imageId}
                className="bg-white rounded-lg shadow-sm overflow-hidden hover:shadow-md transition-shadow border border-gray-200"
              >
                <div 
                  className="aspect-square relative cursor-pointer"
                  onClick={() => {
                    setSelectedImage(image);
                    toggleHeaderFooter(false);
                  }}
                >
                  <img
                    src={image.imageUrl}
                    alt={`Photo from ${image.eventName}`}
                    className="object-cover w-full h-full"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload(image.imageUrl);
                    }}
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
            <p className="mt-2 text-gray-500">No photos found for this event</p>
          </div>
        )}
        
        {/* Enlarged Image Modal */}
        {selectedImage && (
          <div 
            className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4" 
            onClick={() => {
              setSelectedImage(null);
              toggleHeaderFooter(true);
            }}
          >
            <div className="relative bg-white rounded-lg shadow-xl max-w-[800px] max-h-[600px] w-full mx-auto" onClick={e => e.stopPropagation()}>
              <img
                src={selectedImage.imageUrl}
                alt={`Enlarged photo from ${selectedImage.eventName}`}
                className="w-full h-full object-contain rounded-lg"
                style={{ maxHeight: 'calc(600px - 4rem)' }}
              />
              <button
                className="absolute top-4 right-4 p-2 rounded-full bg-black/20 text-white hover:bg-black/70 transition-colors duration-200"
                onClick={() => {
                  setSelectedImage(null);
                  toggleHeaderFooter(true);
                }}
              >
                <X className="w-8 h-8" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload(selectedImage.imageUrl);
                }}
                className="absolute bottom-4 right-4 p-2 rounded-full bg-black/10 text-white hover:bg-black/70 transition-colors duration-200 flex items-center gap-2"
              >
                <Download className="w-6 h-6" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default EventPhotos; 