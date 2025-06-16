import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchTenantDetails } from '../api';

function TenantDetailsPage() {
    const { tenantId } = useParams();
    const [tenant, setTenant] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const loadDetails = async () => {
            try {
                const response = await fetchTenantDetails(tenantId);
                setTenant(response.data);
            } catch (error) {
                console.error("Failed to fetch tenant details", error);
            } finally {
                setIsLoading(false);
            }
        };
        loadDetails();
    }, [tenantId]);

    if (isLoading) return <p>Loading details...</p>;
    if (!tenant) return <p>Tenant not found.</p>;
    
    let fullLogoUrl = null;
    if (tenant.logo_url) {
        if (tenant.logo_url.startsWith('http')) {
            fullLogoUrl = tenant.logo_url;
        } else {
            fullLogoUrl = `http://localhost:3003${tenant.logo_url}`;
        }
    }
    return (
        <div className="form-container">
            <Link to="/">← Back to Dashboard</Link>
            <h2>Details for {tenant.organization_name}</h2>
            
            {fullLogoUrl ? (
                <div style={{ margin: '1rem 0' }}>
                    <p><strong>Tenant Logo:</strong></p>
                    <img 
                        src={fullLogoUrl} 
                        alt={`${tenant.organization_name} Logo`} 
                        style={{ 
                            maxWidth: '200px', 
                            maxHeight: '100px', 
                            border: '1px solid #ddd',
                            padding: '5px',
                            backgroundColor: 'white'
                        }} 
                    />
                </div>
            ) : (
                <p><strong>Tenant Logo:</strong> Not provided</p>
            )}

            <div className="details-grid">
                <p><strong>Tenant ID:</strong> {tenant.tenant_id}</p>
                <p><strong>Subdomain:</strong> {tenant.subdomain || 'N/A'}</p>
                <p><strong>Address:</strong> {tenant.address || 'N/A'}</p>
                <p><strong>Timezone:</strong> {tenant.timezone || 'N/A'}</p>
                <p><strong>Currency:</strong> {tenant.currency || 'N/A'}</p>
                <p><strong>Created:</strong> {new Date(tenant.created_at).toLocaleString()}</p>
            </div>
        </div>
    );
}


export default TenantDetailsPage;
