import React from 'react';

function CreateTenantForm({ onSubmit }) {
    // No more local state! The form submit will handle everything.

    const handleSubmit = (e) => {
        e.preventDefault();
        // Create a FormData object from the form element
        const formData = new FormData(e.target);
        onSubmit(formData);
    };

    return (
        <div className="form-container" style={{ marginTop: '2rem' }}>
            <h3>New Tenant Details</h3>
            <form onSubmit={handleSubmit} className="form-grid" encType="multipart/form-data">
                {/* Tenant Info */}
                <div><label>Tenant ID*</label><input name="tenantId" required /></div>
                <div><label>Organization Name*</label><input name="organizationName" required /></div>
                
                {/* --- LOGO UPLOAD LOGIC --- */}
                <div className="full-width">
                    <p><strong>Logo:</strong> Provide a URL or upload a file.</p>
                </div>
                <div>
                    <label>Logo from URL</label>
                    <input name="logoUrl" placeholder="https://example.com/logo.png" />
                </div>
                <div>
                    <label>Or Upload Logo File</label>
                    {/* The name 'logo' must match the multer middleware on the backend */}
                    <input name="logo" type="file" />
                </div>

                <div><label>Desired Subdomain</label><input name="subdomain" /></div>
                <div><label>Address</label><input name="address" /></div>
                <div><label>Timezone</label><input name="timezone" /></div>
                <div><label>Currency</label><input name="currency" /></div>

                {/* Initial User Info */}
                <div className="full-width"><h3>Initial Admin User for Tenant</h3></div>
                <div><label>Username*</label><input name="username" required /></div>
                <div><label>Password*</label><input name="password" type="password" required /></div>
                
                <div className="full-width">
                    <button type="submit">Create Tenant</button>
                </div>
            </form>
        </div>
    );
}

export default CreateTenantForm;
