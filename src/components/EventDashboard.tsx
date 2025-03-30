import React, { useState, useEffect, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, Image, Video, Users, Plus, X, Trash2, Copy } from 'lucide-react';
import { 
    storeEventData, 
    getEventStatistics, 
    getUserEvents, 
    EventData, 
    deleteEvent, 
    getEventsByOrganizerId,
    getEventsByUserId,
    getEventById
} from '../config/eventStorage';
import { s3Client, S3_BUCKET_NAME } from '../config/aws';
import { Upload } from '@aws-sdk/lib-storage';
import { UserContext } from '../App';
import { storeUserCredentials, getUserByEmail } from '../config/dynamodb';

interface Event {
    id: string;
    name: string;
    date: string;
    description?: string;
    coverImage?: File;
}

interface StatsCardProps {
    icon: React.ReactNode;
    title: string;
    count: number;
    bgColor: string;
    className?: string;
    titleColor?: string;
}

const StatsCard: React.FC<StatsCardProps> = ({ icon, title, count, bgColor, className, titleColor }) => (
    <div className={`${bgColor} p-4 sm:p-6 rounded-lg shadow-md flex items-center space-x-4 ${className || ''}`}>
        <div className="p-2 sm:p-3 bg-white rounded-full">{icon}</div>
        <div>
            <h3 className={`text-sm sm:text-xl font-semibold ${titleColor || 'text-blue-900'}`}>{title}</h3>
            <p className="text-lg sm:text-2xl font-bold text-black">{count}</p>
        </div>
    </div>
);

interface EventDashboardProps {
    setShowNavbar: (show: boolean) => void;
}

// Function to generate a unique 6-digit event ID
const generateUniqueEventId = async (): Promise<string> => {
    const generateSixDigitId = (): string => {
        // Generate a random 6-digit number
        return Math.floor(100000 + Math.random() * 900000).toString();
    };
    
    // Generate an initial ID
    let eventId = generateSixDigitId();
    
    // Check if the ID already exists in the database
    // If it does, generate a new one until we find a unique ID
    let isUnique = false;
    let maxAttempts = 10; // Prevent infinite loops
    let attempts = 0;
    
    while (!isUnique && attempts < maxAttempts) {
        attempts++;
        try {
            // Check if an event with this ID already exists
            const existingEvent = await getEventById(eventId);
            
            if (!existingEvent) {
                // ID is unique
                isUnique = true;
            } else {
                // ID exists, generate a new one
                console.log(`Event ID ${eventId} already exists, generating a new one...`);
                eventId = generateSixDigitId();
            }
        } catch (error) {
            console.error('Error checking event ID uniqueness:', error);
            // If there's an error checking, assume it's unique to avoid getting stuck
            isUnique = true;
        }
    }
    
    if (attempts >= maxAttempts) {
        console.warn('Reached maximum attempts to generate a unique ID');
    }
    
    return eventId;
};

const EventDashboard = (props: EventDashboardProps) => {
    const navigate = useNavigate();
    const { userEmail, userRole, setUserRole } = useContext(UserContext);
    const [deleteConfirmation, setDeleteConfirmation] = useState<{isOpen: boolean; eventId: string; userEmail: string}>({isOpen: false, eventId: '', userEmail: ''});

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [newEvent, setNewEvent] = useState<Event>({ id: '', name: '', date: '' });
    const [coverImagePreview, setCoverImagePreview] = useState<string | null>(null);

    const [stats, setStats] = useState({ eventCount: 0, photoCount: 0, videoCount: 0, guestCount: 0 });
    const [isLoading, setIsLoading] = useState(false);
    const [events, setEvents] = useState<EventData[]>([]);
    const [showAllEvents, setShowAllEvents] = useState(true);
    const [copiedEventId, setCopiedEventId] = useState<string | null>(null);

    useEffect(() => {
        loadEvents();

        // Check URL query parameters for 'create=true'
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('create') === 'true') {
            // Update user role to organizer when directed to create event
            const updateUserRole = async () => {
                const email = localStorage.getItem('userEmail');
                if (email) {
                    // Get user info from localStorage
                    let name = '';
                    const userProfileStr = localStorage.getItem('userProfile');
                    if (userProfileStr) {
                        try {
                            const userProfile = JSON.parse(userProfileStr);
                            name = userProfile.name || '';
                        } catch (e) {
                            console.error('Error parsing user profile from localStorage', e);
                        }
                    }
                    
                    const mobile = localStorage.getItem('userMobile') || '';
                    
                    // Update user role to organizer
                    await storeUserCredentials({
                        userId: email,
                        email,
                        name,
                        mobile,
                        role: 'organizer'
                    });
                    
                    // Update local context
                    setUserRole('organizer');
                }
            };
            
            updateUserRole();
            setIsModalOpen(true);
            // Remove the parameter from URL without refreshing
            navigate('/events', { replace: true });
        }
    }, [navigate, setUserRole]);

    const loadEvents = async () => {
        try {
            const userEmail = localStorage.getItem('userEmail');
            if (!userEmail) {
                console.error('User email not found');
                return;
            }
            
            console.log('Loading events for user:', userEmail);
            
            // Get events where user is listed as userEmail (backward compatibility)
            const userEvents = await getUserEvents(userEmail);
            
            // Get events where user is the organizer
            const organizerEvents = await getEventsByOrganizerId(userEmail);
            
            // Get events where user is the userId
            const userIdEvents = await getEventsByUserId(userEmail);
            
            // Combine events and remove duplicates (based on eventId)
            const allEvents = [...userEvents];
            
            // Add organizer events that aren't already in the list
            organizerEvents.forEach(orgEvent => {
                if (!allEvents.some(event => event.id === orgEvent.id)) {
                    allEvents.push(orgEvent);
                }
            });
            
            // Add userId events that aren't already in the list
            userIdEvents.forEach(userIdEvent => {
                if (!allEvents.some(event => event.id === userIdEvent.id)) {
                    allEvents.push(userIdEvent);
                }
            });
            
            if (Array.isArray(allEvents)) {
                setEvents(allEvents);
                // Update statistics after loading events
                await loadEventStatistics();
            } else {
                console.error('Invalid events data received');
            }
        } catch (error) {
            console.error('Error loading events:', error);
        }
    };

    useEffect(() => {
        loadEventStatistics();
    }, []);

    const loadEventStatistics = async () => {
        try {
            const userEmail = localStorage.getItem('userEmail');
            if (userEmail) {
                console.log('Loading statistics for user:', userEmail);
                const statistics = await getEventStatistics(userEmail);
                setStats(statistics);
            }
        } catch (error) {
            console.error('Error loading event statistics:', error);
            // Set default stats on error
            setStats({
                eventCount: 0,
                photoCount: 0,
                videoCount: 0,
                guestCount: 0
            });
        }
    };

    const handleCoverImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            // No size limit for cover images
            setNewEvent(prev => ({ ...prev, coverImage: file }));
            setCoverImagePreview(URL.createObjectURL(file));
        }
    };

    const handleOpenCreateModal = async () => {
        try {
            // Hide navbar immediately when opening create event modal
            props.setShowNavbar(false);
            
            // Update user role if needed
            if (userRole !== 'organizer') {
                console.log('Updating user role to organizer');
                const email = localStorage.getItem('userEmail');
                if (email) {
                    // Get user info from localStorage
                    let name = '';
                    const userProfileStr = localStorage.getItem('userProfile');
                    if (userProfileStr) {
                        try {
                            const userProfile = JSON.parse(userProfileStr);
                            name = userProfile.name || '';
                        } catch (e) {
                            console.error('Error parsing user profile from localStorage', e);
                        }
                    }
                    
                    const mobile = localStorage.getItem('userMobile') || '';
                    
                    // Update user role to organizer
                    await storeUserCredentials({
                        userId: email,
                        email,
                        name,
                        mobile,
                        role: 'organizer'
                    });
                    
                    // Update local context
                    setUserRole('organizer');
                    console.log('User role updated to organizer');
                }
            }
        } catch (error) {
            console.error('Error updating user role:', error);
        }
        
        // Open the modal
        setIsModalOpen(true);
    };

    const handleCreateEvent = async (e: React.FormEvent) => {
        e.preventDefault();
        console.log('Starting event creation process...');
        
        if (!newEvent.name || !newEvent.date || !newEvent.coverImage) {
            console.log('Validation failed:', { name: newEvent.name, date: newEvent.date, coverImage: !!newEvent.coverImage });
            alert('Please fill in all required fields including cover image');
            return;
        }

        setIsLoading(true);
        props.setShowNavbar(false);

        try {
            const userEmail = localStorage.getItem('userEmail');
            if (!userEmail) {
                console.error('User not authenticated - no email found in localStorage');
                throw new Error('User not authenticated');
            }
            console.log('User authenticated:', userEmail);

            // Generate a unique 6-digit event ID
            const eventId = await generateUniqueEventId();
            console.log('Generated event ID:', eventId);

            // Handle cover image upload first
            let coverImageUrl = '';
            if (newEvent.coverImage) {
                console.log('Starting cover image upload...');
                const coverImageKey = `events/shared/${eventId}/cover.jpg`;
                console.log('Cover image key:', coverImageKey);
                
                try {
                    // Convert File to arrayBuffer and then to Uint8Array, which works properly with Buffer.concat
                    const buffer = await newEvent.coverImage.arrayBuffer();
                    const uint8Array = new Uint8Array(buffer);
                    
                    // Upload using AWS SDK
                    const uploadCoverImage = new Upload({
                        client: s3Client,
                        params: {
                            Bucket: S3_BUCKET_NAME,
                            Key: coverImageKey,
                            Body: uint8Array,
                            ContentType: newEvent.coverImage.type,
                            ACL: 'public-read'
                        },
                        partSize: 1024 * 1024 * 5
                    });

                    console.log('Starting S3 upload...');
                    await uploadCoverImage.done();
                    console.log('S3 upload completed successfully');
                    
                    coverImageUrl = `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${coverImageKey}`;
                    console.log('Cover image URL:', coverImageUrl);
                } catch (uploadError) {
                    console.error('Error uploading cover image:', uploadError);
                    throw new Error('Failed to upload cover image. Please try again.');
                }
            }

            // Update user role and create event data
            try {
                // Get user info from localStorage
                let name = '';
                const userProfileStr = localStorage.getItem('userProfile');
                if (userProfileStr) {
                    try {
                        const userProfile = JSON.parse(userProfileStr);
                        name = userProfile.name || '';
                    } catch (e) {
                        console.error('Error parsing user profile from localStorage', e);
                    }
                }
                
                const mobile = localStorage.getItem('userMobile') || '';
                console.log('User profile loaded:', { name, mobile });

                // Get existing user data
                const existingUser = await getUserByEmail(userEmail);
                console.log('Retrieved existing user data:', existingUser);
                let eventIds: string[] = [];
                
                if (existingUser?.createdEvents && Array.isArray(existingUser.createdEvents)) {
                    eventIds = [...existingUser.createdEvents];
                }
                
                eventIds.push(eventId);
                
                // Update user role and createdEvents
                await storeUserCredentials({
                    userId: userEmail,
                    email: userEmail,
                    name,
                    mobile,
                    role: 'organizer',
                    createdEvents: eventIds
                });
                
                setUserRole('organizer');

                // Create event data
                const eventData: EventData = {
                    id: eventId,
                    name: newEvent.name,
                    date: newEvent.date,
                    description: newEvent.description,
                    coverImage: coverImageUrl,
                    photoCount: 0,
                    videoCount: 0,
                    guestCount: 0,
                    userEmail,
                    organizerId: userEmail,
                    userId: userEmail,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    eventUrl: `${window.location.origin}/attendee-dashboard?eventId=${eventId}`
                };

                // Store event data
                console.log('Storing event data...');
                const success = await storeEventData(eventData);
                
                if (success) {
                    console.log('Event created successfully');
                    await loadEventStatistics();
                    await loadEvents();
                    setIsModalOpen(false);
                    setNewEvent({ id: '', name: '', date: '', description: '' });
                    setCoverImagePreview(null);
                    props.setShowNavbar(true);
                    
                    // Navigate directly to the upload images page
                    console.log('Navigating to upload images page:', `/upload-image?eventId=${eventId}`);
                    navigate(`/upload-image?eventId=${eventId}`);
                } else {
                    throw new Error('Failed to store event data');
                }
            } catch (error) {
                console.error('Error in event creation process:', error);
                throw error;
            }
        } catch (error: any) {
            console.error('Error creating event:', error);
            alert(error.message || 'Failed to create event. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleConfirmDelete = async () => {
        if (deleteConfirmation.eventId && deleteConfirmation.userEmail) {
            try {
                const success = await deleteEvent(deleteConfirmation.eventId, deleteConfirmation.userEmail);
                if (success) {
                    // After successful deletion from DynamoDB
                    loadEvents();
                    loadEventStatistics();
                    setDeleteConfirmation({isOpen: false, eventId: '', userEmail: ''});
                } else {
                    alert('Failed to delete event. Please try again.');
                }
            } catch (error) {
                console.error('Error deleting event:', error);
                alert('An error occurred while deleting the event.');
            }
        }
    };

    const handleDeleteClick = (eventId: string, userEmail: string) => {
        setDeleteConfirmation({isOpen: true, eventId, userEmail});
    };

    const handleCopyEventId = (eventId: string) => {
        navigator.clipboard.writeText(eventId);
        setCopiedEventId(eventId);
        setTimeout(() => setCopiedEventId(null), 2000);
    };

    return (
        <div className={`relative bg-blue-45 flex flex-col pt-16 sm:pt-20 ${events.length === 0 ? 'h-[calc(100vh-70px)]' : 'min-h-screen'}`}>
            <div className="relative z-10 container mx-auto px-4 py-4 sm:py-10 flex-grow">
                <div className="mb-4 sm:mb-10 flex flex-row justify-between items-center gap-2 sm:gap-6">
                    <h1 className="text-lg sm:text-3xl font-bold text-blue-900 flex-shrink-0">Event Dashboard</h1>
                    <div>
                        <button
                            onClick={handleOpenCreateModal}
                            className="flex-shrink-0 flex items-center justify-center bg-blue-300 text-white-700 py-3 sm:py-3 px-4 rounded-lg hover:bg-secondary transition-colors duration-200 text-base sm:text-lg w-full sm:w-auto"
                        >
                            <Plus className="w-5 h-5 sm:w-6 sm:h-6 mr-2" />
                            Create Event
                        </button>
                    </div>
                </div>
            
                <div className="flex flex-row gap-2 sm:gap-6 overflow-x-auto pb-4 sm:pb-6 -mx-4 px-4 touch-pan-x">
                    <div onClick={() => setShowAllEvents(!showAllEvents)} className="cursor-pointer flex-1 min-w-[150px] sm:min-w-[250px]">
                        <StatsCard
                            icon={<Image className="w-4 h-4 sm:w-8 sm:h-8 text-blue-900" />}
                            title="Total Events"
                            count={stats.eventCount}
                            bgColor="bg-blue-200"
                            titleColor="text-black"
                        />
                    </div>
                    <div className="flex-1 min-w-[150px] sm:min-w-[250px]">
                        <StatsCard
                            icon={<Camera className="w-4 h-4 sm:w-8 sm:h-8 text-blue-900" />}
                            title="Total Photos"
                            count={stats.photoCount}
                            bgColor="bg-blue-300"
                            titleColor="text-black"
                        />
                    </div>
                </div>

                {/* Create Event Modal */}
                {isModalOpen && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-lg shadow-md border border-blue-400 mx-auto w-full max-w-sm sm:max-w-md overflow-auto max-h-[90vh]">
                            <div className="flex justify-between items-center p-4 border-b border-gray-200">
                                <h2 className="text-lg sm:text-xl font-bold text-blue-700">Create New Event</h2>
                                <button
                                    onClick={() => {
                                        setIsModalOpen(false);
                                        props.setShowNavbar(true);
                                    }}
                                    className="text-black hover:text-gray-700"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <form onSubmit={handleCreateEvent} className="p-4 sm:p-6 space-y-3">
                                {coverImagePreview && (
                                    <div className="relative w-full h-32 sm:h-40 mb-3">
                                        <img
                                            src={coverImagePreview}
                                            alt="Cover preview"
                                            className="w-full h-full object-cover rounded-lg"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setCoverImagePreview(null);
                                                setNewEvent(prev => ({ ...prev, coverImage: undefined }));
                                            }}
                                            className="absolute top-2 right-2 p-1 bg-blue-500 text-white rounded-full hover:bg-blue-600"
                                        >
                                            <X className="w-3 h-3 sm:w-4 sm:h-4" />
                                        </button>
                                    </div>
                                )}
                                <div className="mb-3">
                                    <label className="block text-blue-900 text-sm mb-1" htmlFor="coverImage">
                                        Cover Image <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="file"
                                        id="coverImage"
                                        accept="image/*"
                                        onChange={handleCoverImageChange}
                                        className="w-full text-sm text-blue-900 file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-blue-700 text-sm mb-1" htmlFor="eventName">
                                        Event Name <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        id="eventName"
                                        value={newEvent.name}
                                        onChange={(e) => setNewEvent({ ...newEvent, name: e.target.value })}
                                        className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-blue-700 text-sm mb-1" htmlFor="eventDate">
                                        Event Date <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="date"
                                        id="eventDate"
                                        value={newEvent.date}
                                        onChange={(e) => setNewEvent({ ...newEvent, date: e.target.value })}
                                        className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                                        required
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={isLoading}
                                    className="w-full bg-blue-300 text-black py-2 px-4 rounded-lg hover:bg-secondary transition-colors duration-200 disabled:opacity-50 mt-4 text-sm sm:text-base"
                                >
                                    {isLoading ? 'Creating Event...' : 'Create Event'}
                                </button>
                            </form>
                        </div>
                    </div>
                )}

                <div className="text-center mb-8"></div>

                {/* Delete Confirmation Modal */}
                {deleteConfirmation.isOpen && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                        <div className="bg-white rounded-lg p-6 max-w-sm w-full">
                            <h3 className="text-xl font-bold text-gray-800 mb-4">Confirm Delete</h3>
                            <p className="text-gray-600 mb-6">Are you sure you want to delete this event? This action cannot be undone.</p>
                            <div className="flex justify-end space-x-4">
                                <button
                                    onClick={() => setDeleteConfirmation({isOpen: false, eventId: '', userEmail: ''})}
                                    className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors duration-200"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmDelete}
                                    className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-colors duration-200"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {showAllEvents && events.length > 0 && (
                    <div className="mt-4 sm:mt-8">
                        <h2 className="text-xl sm:text-2xl font-bold text-blue-900 mb-4 sm:mb-6">All Events</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-8">
                            {Array.isArray(events) && events.map((event) => (
                                <div key={event.id} className="bg-blue-200 rounded-lg shadow-md border-2 border-blue-700 overflow-hidden">
                                    <div className="w-full h-32 sm:h-64 bg-white rounded-lg shadow-md border-2 border-blue-300 flex items-center justify-center">
                                        {event.coverImage ? (
                                            <img src={event.coverImage} alt={event.name} className="w-full h-full object-cover" />
                                        ) : (
                                            <Camera className="w-8 h-8 sm:w-16 sm:h-16 text-blue-700" />
                                        )}
                                    </div>
                                    <div className="p-2 sm:p-6">
                                        <h3 className="text-base sm:text-2xl font-semibold text-blue-800 mb-1 sm:mb-3">{event.name}</h3>
                                        <div className="flex items-center mb-1 sm:mb-3">
                                            <span className="text-sm sm:text-base font-medium text-gray-700 mr-2">Event Code:</span>
                                            <div className="bg-blue-100 px-2 py-1 rounded-md flex items-center">
                                                <span className="text-sm sm:text-base font-mono">{event.id}</span>
                                                <button 
                                                    onClick={() => handleCopyEventId(event.id)}
                                                    className="ml-2 text-blue-700 hover:text-blue-900"
                                                    title="Copy event code"
                                                >
                                                    <Copy className="w-4 h-4" />
                                                </button>
                                                {copiedEventId === event.id && (
                                                    <span className="ml-2 text-xs text-green-600">Copied!</span>
                                                )}
                                            </div>
                                        </div>
                                        <p className="text-sm sm:text-lg text-black-600 mb-1 sm:mb-3">{new Date(event.date).toLocaleDateString()}</p>
                                        <p className="text-xs sm:text-base text-black-500 mb-2 sm:mb-4 line-clamp-2">{event.description}</p>
                                        <div className="flex justify-between items-center">
                                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-6"></div>
                                            <div className="mt-2 sm:mt-4 flex justify-end space-x-3 sm:space-x-4">
                                                <Link
                                                    to={`/view-event/${event.id}`}
                                                    className="bg-blue-300 text-black px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg hover:bg-blue-600 transition-colors duration-200 text-sm sm:text-base"
                                                >
                                                    View Event
                                                </Link>
                                                <button
                                                    onClick={() => handleDeleteClick(event.id, event.userEmail)}
                                                    className="bg-blue-500 text-blue px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg hover:bg-blue-600 transition-colors duration-200 flex items-center text-sm sm:text-base"
                                                >
                                                    <Trash2 className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default EventDashboard;